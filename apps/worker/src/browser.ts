import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import {
  capturePdfDownload,
  MAX_DOWNLOAD_BYTES,
  type PdfDownload,
  readDownloadFailures,
} from "./downloads.ts";
import { WorkerError } from "./errors.ts";
import {
  MAX_QUERY,
  MAX_SEARCH_RESULTS,
  REF_ATTRIBUTE,
  REF_PATTERN,
  refNumber,
  searchResultsScript,
  snapshotLimits,
  snapshotScript,
} from "./extract.ts";
import { validatePublicUrl } from "./network.ts";
import { startEgressProxy } from "./proxy.ts";

export interface Session {
  id: string;
  title: string;
  url: string;
  status: "active" | "closed" | "error";
  updatedAt: string;
}
/** Longest a session may hold several tabs open at once. */
export const MAX_TABS = 8;

/**
 * A running session. `tabs` holds every open page and `active` is the index the next
 * action applies to; a session always has at least its first tab, so `active` is a valid
 * index whenever the session is running.
 */
type Running = {
  context: BrowserContext;
  tabs: Page[];
  active: number;
  touched: number;
  pending: Set<Promise<void>>;
  downloadError?: boolean;
  /** True while a caller-driven tab creation is in flight, so the popup guard adopts it. */
  adopting: boolean;
  /**
   * Where the agent's pointer last was.
   *
   * Chromium gives no cursor position, so the mirror cannot draw a true cursor;
   * it draws the last place the agent touched, which for every action that moves
   * it — a click, an element activation — is exactly where the agent is
   * working. Tracked here rather than at the server because only the worker
   * knows which of the two happened.
   */
  cursor: { x: number; y: number };
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new WorkerError("INVALID_SESSION", "A valid UUID session ID is required.");
  return id.toLowerCase();
}

/** Screenshots are 1280x800, and clicks are addressed in that coordinate space. */
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;
export const MAX_INPUT_TEXT = 10_000;
export const MAX_SCROLL = 5000;
/** Bounds for the element-addressed actions, which supersede coordinate guessing. */
export const MAX_REF_ORDINAL = 999;
/** Longest plain pause the agent may request, so a wait cannot stall a task run. */
export const MAX_DELAY = 10_000;
/** How long a page may be given to settle before a wait gives up. */
export const MAX_WAIT_TIMEOUT = 15_000;

/**
 * A file name a caller may name for upload. Only a plain base name with an ordinary
 * extension is accepted: no separators, no traversal, nothing that resolves outside the
 * session's own upload folder.
 */
export function isSafeFileName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 180 &&
    /^[\w][\w. -]{0,170}\.[A-Za-z0-9]{1,10}$/.test(value) &&
    !value.includes("..")
  );
}
/** The only keys a caller may press. Nothing else reaches the page keyboard. */
export const INPUT_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Control+a",
  "Meta+a",
  "Shift+Tab",
] as const;
export type BrowserInput =
  | { type: "click"; x: number; y: number }
  | { type: "activate"; ref: string }
  | { type: "fill"; ref: string; text: string }
  | { type: "select"; ref: string; value: string }
  | { type: "check"; ref: string; checked: boolean }
  | { type: "upload"; ref: string; file: string }
  | { type: "text"; text: string }
  | { type: "key"; key: (typeof INPUT_KEYS)[number] }
  | { type: "scroll"; deltaY: number }
  | { type: "nav"; to: "back" | "forward" | "reload" }
  | { type: "wait"; until: WaitUntil; ref?: string; ms?: number };

/** What a wait is for. Fixed verbs and one optional ref, never a selector. */
export type WaitUntil = "idle" | "text" | "element" | "delay";

const isInputKey = (value: unknown): value is (typeof INPUT_KEYS)[number] =>
  typeof value === "string" && (INPUT_KEYS as readonly string[]).includes(value);

/**
 * A ref names one element of the most recent snapshot. It is accepted in the shape
 * `e<N>` only: anything else could not have come from a snapshot this worker produced.
 */
function validRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    REF_PATTERN.test(value) &&
    refNumber(value) >= 1 &&
    refNumber(value) <= MAX_REF_ORDINAL
  );
}

/**
 * Narrows an untrusted request body to exactly one supported action. Kept pure and
 * exported so the bounds are covered without launching a browser.
 */
export function validateInput(input: Record<string, unknown>): BrowserInput {
  const { type, x, y, key, text, deltaY, ref, value, checked, to, until, ms, file } = input;
  const invalid = new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
  if (
    type === "click" &&
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    x < SCREEN_WIDTH &&
    y >= 0 &&
    y < SCREEN_HEIGHT
  )
    return { type: "click", x, y };
  // Element-addressed actions. A ref is the only identifier they accept: the worker never
  // runs a caller-supplied selector, so this cannot reach an element the snapshot did not
  // offer.
  if (type === "activate" && validRef(ref)) return { type: "activate", ref };
  if (
    type === "fill" &&
    validRef(ref) &&
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= MAX_INPUT_TEXT
  )
    return { type: "fill", ref, text };
  if (
    type === "select" &&
    validRef(ref) &&
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_INPUT_TEXT
  )
    return { type: "select", ref, value };
  if (type === "check" && validRef(ref) && typeof checked === "boolean")
    return { type: "check", ref, checked };
  // A file is named, never carried. The worker resolves the name against uploads the
  // session owner already stored, so a caller cannot push arbitrary bytes at a page.
  if (type === "upload" && validRef(ref) && isSafeFileName(file))
    return { type: "upload", ref, file };
  // Waiting is how the agent lets a page finish arriving before acting on it. `element`
  // and `text` are bounded by the worker's own wait timeout; `delay` is the plain pause.
  if (
    type === "wait" &&
    (until === "idle" || until === "text" || until === "element" || until === "delay")
  ) {
    if (until === "element" && !validRef(ref)) throw invalid;
    if (
      until === "delay" &&
      (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > MAX_DELAY)
    )
      throw invalid;
    // `ms` and `ref` are meaningless for the other verbs, so they are not carried.
    return until === "delay" ? { type: "wait", until, ms: ms as number } : { type: "wait", until };
  }
  if (
    type === "text" &&
    typeof text === "string" &&
    text.length > 0 &&
    text.length <= MAX_INPUT_TEXT
  )
    return { type: "text", text };
  if (type === "key" && isInputKey(key)) return { type: "key", key };
  if (
    type === "scroll" &&
    typeof deltaY === "number" &&
    Number.isFinite(deltaY) &&
    Math.abs(deltaY) <= MAX_SCROLL
  )
    return { type: "scroll", deltaY };
  // History moves are fixed verbs. The worker keeps no caller-supplied address here, so a
  // `nav` can only revisit where the session already has been.
  if (type === "nav" && (to === "back" || to === "forward" || to === "reload"))
    return { type: "nav", to };
  throw invalid;
}

/** One frame of the agent's browser, for the live mirror. */
export interface Frame {
  bytes: Buffer;
  cursor: { x: number; y: number };
  url: string;
  title: string;
}

/**
 * Quality of a mirrored frame.
 *
 * Deliberately low. The mirror exists so a person can see *which page* the
 * agent is reading, and the alternative to a legible thumbnail at 4fps is a
 * full-quality screenshot that saturates the worker socket and starves the
 * agent's own work. 45 is past the point where JPEG artefacts are visible at
 * the size this renders.
 */
const FRAME_QUALITY = 45;

/** A mirrored frame is never larger than this; the codec refuses anything bigger. */
export const MAX_FRAME_BYTES = 512 * 1024;

export async function createBrowserManager(options: {
  dataDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
}) {
  const { dataDir, maxSessions = 3, idleTimeoutMs = 30 * 60_000 } = options;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const proxy = await startEgressProxy();
  for (const id of await readdir(dataDir)) {
    if (!SESSION_ID.test(id)) continue;
    try {
      const stored = JSON.parse(
        await readFile(join(dataDir, id, "session.json"), "utf8"),
      ) as Session;
      sessions.set(id, { ...stored, id, status: "closed" });
    } catch {
      /* An incomplete first launch has no session metadata to restore. */
    }
    if (sessions.has(id)) await readDownloadFailures(join(dataDir, id), true);
  }
  const directory = (id: string) => join(dataDir, validateSessionId(id));
  async function persist(session: Session) {
    const path = join(directory(session.id), "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function active(id: string) {
    const value = running.get(id);
    if (!value || value.tabs.length === 0)
      throw new WorkerError(
        "SESSION_CLOSED",
        "Open this browser session before using its console.",
        409,
      );
    // A tab the page itself closed is dropped rather than left in the list, so the
    // active index always points at a live page.
    value.tabs = value.tabs.filter((tab) => !tab.isClosed());
    if (value.tabs.length === 0)
      throw new WorkerError("SESSION_CLOSED", "This session has no open tab.", 409);
    value.active = Math.min(Math.max(value.active, 0), value.tabs.length - 1);
    value.touched = Date.now();
    return value;
  }
  /** The page the next action applies to. */
  const pageOf = (instance: Running) => instance.tabs[instance.active];
  async function refresh(id: string) {
    const instance = active(id);
    const page = pageOf(instance);
    if (page.url() !== "about:blank") await validatePublicUrl(page.url());
    const session: Session = {
      id,
      title: (await page.title()).slice(0, 300),
      url: page.url(),
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    await persist(session);
    return session;
  }
  async function downloads(id: string): Promise<PdfDownload[]> {
    if (!sessions.has(id))
      throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    const folder = join(directory(id), "downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const list: PdfDownload[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const item = JSON.parse(await readFile(join(folder, name), "utf8")) as PdfDownload;
      list.push(item);
    }
    return list;
  }
  async function navigate(id: string, url: string) {
    const target = await validatePublicUrl(url);
    const page = pageOf(active(id));
    try {
      await page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
      // Chromium can follow redirects outside Playwright's initial route hook.
      // The proxy blocks those sockets, but its 403 is still an HTTP response:
      // validate the final location so the API does not report it as success.
      await validatePublicUrl(page.url());
    } catch (error) {
      if (error instanceof WorkerError && error.code === "BLOCKED_URL") {
        await page.goto("about:blank", { timeout: 5000 });
      }
      // A successful attachment intentionally aborts page navigation.
      if (!(error instanceof Error && /Download is starting/.test(error.message))) {
        throw new WorkerError(
          "NAVIGATION_FAILED",
          "The page could not be loaded. It may be unreachable or contain a blocked destination.",
          502,
        );
      }
    }
    return refresh(id);
  }
  /**
   * Reads the live page. `elements` and `links` are opt-in because a plain text read is
   * what the chat and takeover paths want, while the agent needs the addressable model.
   * Evaluation is fixed by the worker; callers cannot inject JavaScript.
   */
  async function snapshot(id: string, options: { elements: boolean; links: boolean }) {
    const page = pageOf(active(id));
    await validatePublicUrl(page.url());
    const limits = snapshotLimits();
    const result = await page.evaluate(snapshotScript, {
      ...limits,
      maxElements: options.elements ? limits.maxElements : 0,
      maxLinks: options.links ? limits.maxLinks : 0,
    });
    await validatePublicUrl(result.url);
    const session: Session = {
      id,
      url: result.url,
      title: result.title,
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    await persist(session);
    return result;
  }

  /**
   * Resolves a snapshot ref to the single element carrying it. Refs are stamped on the
   * document, so a ref from a page that has navigated away finds nothing and is refused
   * rather than resolved against whatever happens to occupy that position now.
   */
  async function locate(page: Page, ref: string) {
    const selector = `[${REF_ATTRIBUTE}="${ref}"]`;
    const element = page.locator(selector).first();
    if ((await element.count()) !== 1)
      throw new WorkerError(
        "STALE_REF",
        "That element is no longer on the page. Read the page again for current element refs.",
        409,
      );
    return element;
  }

  const missing = (detail: string) =>
    new WorkerError("ELEMENT_MISMATCH", `That element cannot ${detail}. Read the page again.`, 409);

  /** Clicks a link or button by ref, which is what replaces coordinate guessing. */
  async function activate(page: Page, ref: string) {
    const element = await locate(page, ref);
    const tag = await element.evaluate((node) => node.tagName.toLowerCase());
    if (tag !== "a" && tag !== "button" && tag !== "summary" && tag !== "input")
      throw missing("be activated");
    await element.click({ timeout: 10_000 });
  }

  /**
   * Sets a form field by ref. Playwright's fill dispatches the input and change events a
   * real page expects, and a password field is refused outright: credential entry stays
   * with the user, so this guard is duplicated at the server and matters at the worker
   * because the worker is the authority when the server is bypassed.
   */
  async function fill(page: Page, ref: string, text: string) {
    const element = await locate(page, ref);
    const kind = await element.evaluate((node) => {
      const tag = node.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") return tag;
      return `${tag}:${(node.getAttribute("type") ?? "text").toLowerCase()}`;
    });
    if (kind === "input:password")
      throw new WorkerError(
        "CREDENTIAL_FIELD",
        "OpenMuse will not type into a password field. Ask the user to sign in themselves.",
        403,
      );
    if (
      kind !== "input:text" &&
      kind !== "input:search" &&
      kind !== "input:email" &&
      kind !== "input:tel" &&
      kind !== "input:url" &&
      kind !== "input:number" &&
      kind !== "textarea"
    )
      throw missing("be filled");
    await element.fill(text, { timeout: 10_000 });
  }

  /** Chooses an option in a `<select>` reported by the snapshot. */
  async function selectOption(page: Page, ref: string, value: string) {
    const element = await locate(page, ref);
    const ok = await element.evaluate((node, chosen) => {
      if (node.tagName.toLowerCase() !== "select") return false;
      const select = node as HTMLSelectElement;
      return Array.from(select.options).some(
        (option) => option.label === chosen || option.value === chosen || option.text === chosen,
      );
    }, value);
    if (!ok) throw missing("take that option");
    await element.selectOption(value, { timeout: 10_000 });
  }

  /** Sets a checkbox or radio to a known state, which is idempotent. */
  async function check(page: Page, ref: string, checked: boolean) {
    const element = await locate(page, ref);
    const kind = await element.evaluate((node) => {
      if (node.tagName.toLowerCase() !== "input") return node.tagName.toLowerCase();
      const type = (node.getAttribute("type") ?? "").toLowerCase();
      return type === "checkbox" || type === "radio" ? `input:${type}` : `input:${type}`;
    });
    if (kind !== "input:checkbox" && kind !== "input:radio") throw missing("be checked");
    // setChecked is a no-op when the state already matches, so a repeated call is safe.
    await element.setChecked(checked, { timeout: 10_000 });
  }

  /**
   * Move the mirror's cursor to the element an action just touched.
   *
   * Best-effort by design: an element that has been replaced since the snapshot,
   * or one scrolled out of the viewport, leaves the cursor where it was. That is a
   * cosmetic inaccuracy in a watch-only stream, and it must never be allowed to
   * fail the action that was already performed.
   */
  async function moveCursorTo(page: Page, instance: Running, ref: string) {
    try {
      const box = await (await locate(page, ref)).boundingBox();
      if (!box) return;
      instance.cursor = {
        x: Math.max(0, Math.min(SCREEN_WIDTH, Math.round(box.x + box.width / 2))),
        y: Math.max(0, Math.min(SCREEN_HEIGHT, Math.round(box.y + box.height / 2))),
      };
    } catch {
      /* The element is gone; the cursor stays where it was. */
    }
  }

  /**
   * Lets a page finish arriving before the next action. Real pages fetch and render after
   * the click that triggered them, so acting immediately is the main cause of a
   * mis-read. A timeout is reported as a normal failure rather than thrown raw, so the
   * agent learns the element did not appear and can re-read.
   */
  async function waitFor(page: Page, action: { until: WaitUntil; ref?: string; ms?: number }) {
    const timeout = MAX_WAIT_TIMEOUT;
    if (action.until === "delay") {
      await page.waitForTimeout(Math.min(action.ms ?? 0, MAX_DELAY));
      return;
    }
    if (action.until === "idle") {
      await page.waitForLoadState("networkidle", { timeout }).catch(() => {});
      return;
    }
    if (action.until === "text") {
      // Waiting on body text rather than an element, because the element that matters may
      // not exist yet; the page settling is the thing being waited for.
      await page
        .waitForFunction(() => document.readyState === "complete", null, { timeout })
        .catch(() => {});
      return;
    }
    // `element` waits for the ref to exist. It is deliberately not routed through
    // `locate`, which throws on absence: here absence is the expected outcome to report.
    const selector = `[${REF_ATTRIBUTE}="${action.ref}"]`;
    const appeared = await page
      .locator(selector)
      .first()
      .waitFor({ state: "attached", timeout })
      .then(
        () => true,
        () => false,
      );
    if (!appeared)
      throw new WorkerError(
        "WAIT_TIMEOUT",
        `Element ${action.ref} did not appear. Read the page again; it may still be loading.`,
        409,
      );
  }

  /**
   * Attaches a file the owner already has to a file input. The name is resolved inside the
   * session's own folder and the bytes never travel through a request, so an upload can
   * only ever offer a file this session already stored.
   */
  async function upload(page: Page, id: string, ref: string, file: string) {
    const element = await locate(page, ref);
    const kind = await element.evaluate((node) => {
      if (node.tagName.toLowerCase() !== "input") return node.tagName.toLowerCase();
      return (node.getAttribute("type") ?? "").toLowerCase() === "file"
        ? "input:file"
        : "input:other";
    });
    if (kind !== "input:file") throw missing("accept a file");
    const path = join(directory(id), "uploads", file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile())
      throw new WorkerError("UPLOAD_NOT_FOUND", "That file is not available to upload.", 404);
    if (info.size > MAX_DOWNLOAD_BYTES)
      throw new WorkerError("UPLOAD_TOO_LARGE", "That file exceeds the 10 MiB upload limit.", 413);
    await element.setInputFiles(path, { timeout: 10_000 });
  }

  /** Moves through session history. The verbs are fixed; no address is taken from a caller. */
  async function go(page: Page, to: "back" | "forward" | "reload") {
    if (to === "reload") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      return;
    }
    const moved =
      to === "back"
        ? await page.goBack({ waitUntil: "domcontentloaded" })
        : await page.goForward({ waitUntil: "domcontentloaded" });
    if (!moved)
      throw new WorkerError(
        "NO_HISTORY",
        to === "back"
          ? "There is no earlier page in this session's history."
          : "There is no later page in this session's history.",
        409,
      );
  }

  async function closeSession(id: string) {
    const instance = running.get(id);
    const stored = sessions.get(id);
    if (!stored) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    if (instance) {
      await instance.context.storageState({ path: join(directory(id), "storage.json") });
      await instance.context.close();
      await Promise.allSettled(instance.pending);
      running.delete(id);
    }
    const result: Session = { ...stored, status: "closed", updatedAt: new Date().toISOString() };
    sessions.set(id, result);
    await persist(result);
    return result;
  }
  async function createSession(id: string, url: string) {
    await validatePublicUrl(url);
    if (running.has(id)) return navigate(id, url);
    if (running.size >= maxSessions)
      throw new WorkerError(
        "SESSION_LIMIT",
        `Close an active session before opening another (limit ${maxSessions}).`,
        409,
      );
    if (!sessions.has(id) && sessions.size >= 20)
      throw new WorkerError(
        "PROFILE_LIMIT",
        "The worker has reached its 20 saved-profile limit.",
        409,
      );
    const previous = sessions.get(id);
    const profileDir = join(directory(id), "profile");
    const tempDirectory = join("/tmp", `openmuse-downloads-${id}`);
    await mkdir(profileDir, { recursive: true, mode: 0o700 });
    await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    let context: BrowserContext;
    try {
      const { chromium } = await import("playwright");
      context = await chromium.launchPersistentContext(profileDir, {
        // Chromium does not need the worker API credential in its environment.
        env: {
          HOME: process.env.HOME ?? "/tmp",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C.UTF-8",
        },
        headless: true,
        viewport: { width: 1280, height: 800 },
        proxy: { server: proxy.url, bypass: "<-loopback>" },
        serviceWorkers: "block",
        acceptDownloads: true,
        downloadsPath: tempDirectory,
        timeout: 25_000,
        args: [
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          "--disable-extensions",
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
        ],
      });
    } catch {
      if (!previous) await rm(directory(id), { recursive: true, force: true });
      await rm(tempDirectory, { recursive: true, force: true });
      throw new WorkerError(
        "BROWSER_UNAVAILABLE",
        "Chromium could not start. Rebuild the browser-worker image and check its resource limits.",
        503,
      );
    }
    try {
      const statePath = join(directory(id), "storage.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as Awaited<
          ReturnType<BrowserContext["storageState"]>
        >;
        await context.addCookies(state.cookies);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await context.route("**/*", async (route) => {
        try {
          await validatePublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      for (const old of context.pages()) await old.close();
      const instance: Running = {
        context,
        tabs: [],
        active: 0,
        touched: Date.now(),
        pending: new Set(),
        adopting: true,
        cursor: { x: SCREEN_WIDTH / 2, y: SCREEN_HEIGHT / 2 },
      };
      running.set(id, instance);
      const page = await context.newPage();
      instance.tabs.push(page);
      instance.adopting = false;
      page.setDefaultTimeout(10_000);
      // A page that opens its own window is not part of the agent's session unless the
      // agent asked for one. The context's 'page' event fires as soon as a page starts
      // being created, before the caller can register it, so an in-flight tab creation is
      // claimed through `adopting` rather than being closed as a stray popup.
      context.on("page", (popup) => {
        if (instance.adopting) {
          instance.tabs.push(popup);
          popup.setDefaultTimeout(10_000);
          return;
        }
        void popup.close();
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      page.on("download", (download) => {
        const pending = downloads(id).then((saved) =>
          capturePdfDownload({
            directory: directory(id),
            tempDirectory,
            download,
            limitReached: saved.length + instance.pending.size > 20,
          }),
        );
        instance.pending.add(pending);
        void pending.then(
          () => instance.pending.delete(pending),
          () => {
            instance.downloadError = true;
            instance.pending.delete(pending);
          },
        );
      });
      const initial: Session = {
        id,
        title: previous?.title ?? "New session",
        url,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      sessions.set(id, initial);
      await persist(initial);
      return await navigate(id, url);
    } catch (error) {
      await context.close().catch(() => {});
      await Promise.allSettled(running.get(id)?.pending ?? []);
      running.delete(id);
      if (previous) {
        const failed: Session = {
          ...previous,
          url,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, failed);
        await persist(failed);
      } else {
        sessions.delete(id);
        await rm(directory(id), { recursive: true, force: true });
      }
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const sweeper = setInterval(() => {
    for (const [id, instance] of running)
      if (Date.now() - instance.touched > idleTimeoutMs) {
        void serial(id, () => closeSession(id)).catch(() => {});
      }
  }, 60_000);
  sweeper.unref();
  return {
    list: () => [...sessions.values()],
    create: (id: string, url: string) =>
      serial("create", () => serial(id, () => createSession(id, url))),
    navigate: (id: string, url: string) => serial(id, () => navigate(id, url)),
    closeSession: (id: string) => serial(id, () => closeSession(id)),
    screenshot: (id: string) =>
      serial(id, () => pageOf(active(id)).screenshot({ type: "png", timeout: 10_000 })),
    /**
     * Lists the open tabs, or opens, switches and closes one. The agent uses this to keep
     * a comparison in view while it reads the next page. The active tab is where every
     * other action lands, so switching is itself an observation the caller re-reads.
     */
    tabs: (id: string, action: string, target?: number, url?: string) =>
      serial(id, async () => {
        const instance = active(id);
        const describe = async () => ({
          active: instance.active,
          tabs: await Promise.all(
            instance.tabs.map(async (tab) => ({
              url: tab.url(),
              title: (await tab.title().catch(() => "")).slice(0, 300),
            })),
          ),
        });
        if (action === "list") return describe();
        if (action === "open") {
          if (!url) throw new WorkerError("INVALID_URL", "A URL is required to open a tab.", 400);
          if (instance.tabs.length >= MAX_TABS)
            throw new WorkerError(
              "TOO_MANY_TABS",
              `A session may open at most ${MAX_TABS} tabs.`,
              409,
            );
          const target2 = await validatePublicUrl(url);
          // The popup guard adopts whatever page appears while `adopting` is set, so the
          // new tab is registered for us and is never closed as a stray window.
          instance.adopting = true;
          let created: Page | undefined;
          try {
            created = await instance.context.newPage();
          } finally {
            instance.adopting = false;
          }
          const page = created ?? instance.tabs[instance.tabs.length - 1];
          if (!page)
            throw new WorkerError("NAVIGATION_FAILED", "That tab could not be opened.", 502);
          try {
            await page.goto(target2.url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
            await validatePublicUrl(page.url());
          } catch (error) {
            instance.tabs = instance.tabs.filter((tab) => tab !== page);
            await page.close().catch(() => {});
            throw error instanceof WorkerError
              ? error
              : new WorkerError(
                  "NAVIGATION_FAILED",
                  "That tab could not be opened. The destination may be unreachable or blocked.",
                  502,
                );
          }
          instance.active = instance.tabs.length - 1;
        } else if (action === "switch") {
          if (
            typeof target !== "number" ||
            !Number.isInteger(target) ||
            target < 0 ||
            target >= instance.tabs.length
          )
            throw new WorkerError("NO_SUCH_TAB", "That tab is not open in this session.", 404);
          instance.active = target;
        } else if (action === "close") {
          if (instance.tabs.length === 1)
            throw new WorkerError(
              "LAST_TAB",
              "This is the session's only tab. Open another one before closing it.",
              409,
            );
          if (
            typeof target !== "number" ||
            !Number.isInteger(target) ||
            target < 0 ||
            target >= instance.tabs.length
          )
            throw new WorkerError("NO_SUCH_TAB", "That tab is not open in this session.", 404);
          const [closed] = instance.tabs.splice(target, 1);
          await closed.close().catch(() => {});
          if (instance.active > target) instance.active -= 1;
          instance.active = Math.min(instance.active, instance.tabs.length - 1);
        } else throw new WorkerError("INVALID_INPUT", "Unsupported tab action.");
        await refresh(id);
        return describe();
      }),
    read: (id: string) => snapshot(id, { elements: false, links: false }),
    snapshot: (id: string) => snapshot(id, { elements: true, links: true }),
    search: async (id: string, query: string) => {
      const page = pageOf(active(id));
      const trimmed = query.trim();
      if (!trimmed || trimmed.length > MAX_QUERY)
        throw new WorkerError(
          "INVALID_QUERY",
          "Enter a search query of at most 300 characters.",
          400,
        );
      // DuckDuckGo's HTML endpoint needs no key, renders without JavaScript, and is read
      // through the same public-URL checks as any other navigation.
      const target = await validatePublicUrl(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(trimmed)}`,
      );
      try {
        await page.goto(target.url.href, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await validatePublicUrl(page.url());
      } catch {
        throw new WorkerError("SEARCH_FAILED", "The search could not be completed.", 502);
      }
      const results = (await page.evaluate(searchResultsScript, MAX_SEARCH_RESULTS)) as {
        title: string;
        href: string;
        snippet: string;
      }[];
      // The query page is never the page the agent works on; restoring the previous
      // address keeps a search from silently becoming the task's browsing context.
      return { query: trimmed, url: page.url(), results };
    },
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        const instance = active(id);
        const page = pageOf(instance);
        const action = validateInput(input);
        if (action.type === "click") {
          await page.mouse.click(action.x, action.y);
          instance.cursor = { x: action.x, y: action.y };
        } else if (action.type === "text") await page.keyboard.insertText(action.text);
        else if (action.type === "key") await page.keyboard.press(action.key);
        else if (action.type === "scroll") await page.mouse.wheel(0, action.deltaY);
        else if (action.type === "activate") {
          await activate(page, action.ref);
          await moveCursorTo(page, instance, action.ref);
        } else if (action.type === "fill") {
          await fill(page, action.ref, action.text);
          await moveCursorTo(page, instance, action.ref);
        } else if (action.type === "select") {
          await selectOption(page, action.ref, action.value);
          await moveCursorTo(page, instance, action.ref);
        } else if (action.type === "check") {
          await check(page, action.ref, action.checked);
          await moveCursorTo(page, instance, action.ref);
        } else if (action.type === "upload") {
          await upload(page, id, action.ref, action.file);
          await moveCursorTo(page, instance, action.ref);
        } else if (action.type === "wait") await waitFor(page, action);
        else await go(page, action.to);
        return refresh(id);
      }),
    /**
     * One frame of the live mirror.
     *
     * Serialised on the session queue like every other operation, which is what
     * keeps a mirror at 4fps from interleaving with the action the person is
     * watching. A frame that cannot be taken is an error the caller drops, not a
     * failure of the mirror: the agent's own work is unaffected either way.
     */
    frame: (id: string) =>
      serial(id, async () => {
        const instance = active(id);
        const page = pageOf(instance);
        const bytes = Buffer.from(
          await page.screenshot({ type: "jpeg", quality: FRAME_QUALITY, timeout: 10_000 }),
        );
        if (bytes.length > MAX_FRAME_BYTES)
          throw new WorkerError("FRAME_TOO_LARGE", "The mirrored frame was too large.", 502);
        return {
          bytes,
          cursor: { ...instance.cursor },
          url: page.url().slice(0, 2000),
          title: (await page.title().catch(() => "")).slice(0, 300),
        } satisfies Frame;
      }),
    downloads: async (id: string) => {
      const saved = await downloads(id);
      if (running.get(id)?.downloadError)
        throw new WorkerError(
          "DOWNLOAD_STORE_FAILED",
          "A download outcome could not be saved. Check worker storage and try again.",
          500,
        );
      return { downloads: saved, failures: await readDownloadFailures(directory(id)) };
    },
    download: async (id: string, downloadId: string) => {
      validateSessionId(downloadId);
      const metadata = (await downloads(id)).find((item) => item.id === downloadId);
      if (!metadata) throw new WorkerError("DOWNLOAD_NOT_FOUND", "PDF download not found.", 404);
      const path = join(directory(id), "downloads", `${downloadId}.pdf`);
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES)
        throw new WorkerError("DOWNLOAD_TOO_LARGE", "The PDF exceeds 10 MiB.", 413);
      return { metadata, bytes: await readFile(path) };
    },
    close: async () => {
      clearInterval(sweeper);
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...running.keys()].map(closeSession));
      await proxy.close();
    },
  };
}
