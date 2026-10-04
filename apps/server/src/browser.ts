import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import type { Auth } from "./auth.ts";
import { browserConsole } from "./browser-console.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { browserWireInputSchema, UNSUPPORTED_INPUT_MESSAGE } from "./engine/browser-input.ts";
import { AppError } from "./errors.ts";
import type { Files } from "./files.ts";

const sessionSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.enum(["idle", "active", "closed", "error"]),
  updatedAt: z.string(),
});
const readSchema = z.object({
  url: z.string(),
  title: z.string().max(300),
  text: z.string().max(100_000),
  truncated: z.boolean(),
});
/** One addressable element of the page, as the worker's snapshot described it. */
const elementSchema = z.object({
  ref: z.string().regex(/^e[1-9][0-9]{0,2}$/),
  role: z.enum(["link", "button", "textbox", "checkbox", "radio", "combobox"]),
  name: z.string().max(400),
  value: z.string().max(400).optional(),
  password: z.boolean().optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  href: z.string().max(2000).optional(),
  options: z.array(z.string().max(400)).max(60).optional(),
});
const snapshotSchema = readSchema.extend({
  elements: z.array(elementSchema).max(300),
  links: z.array(z.object({ text: z.string().max(400), href: z.string().max(2000) })).max(400),
});
const searchSchema = z.object({
  query: z.string().max(300),
  url: z.string(),
  results: z
    .array(
      z.object({
        title: z.string().max(400),
        href: z.string().max(2000),
        snippet: z.string().max(700),
      }),
    )
    .max(30),
});
const tabsSchema = z.object({
  active: z.number().int().min(0),
  tabs: z
    .array(z.object({ url: z.string().max(2000), title: z.string().max(300) }))
    .min(1)
    .max(8),
});
const failureSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  message: z.string(),
  createdAt: z.string(),
});
type ChatBrowser = { id: string; sessionId: string };

/** One frame of the live browser mirror, as the mirror hub consumes it. */
export interface BrowserFrame {
  jpeg: Uint8Array;
  cursor: { x: number; y: number };
  url?: string;
  title?: string;
}

/**
 * A header value from the worker, decoded and bounded.
 *
 * The URL and title arrive percent-encoded in headers because a raw header value
 * cannot hold arbitrary page text. A malformed one is dropped rather than
 * allowed to throw: a frame with no title is still worth showing.
 */
const headerText = (value: string | null, max: number): string | undefined => {
  if (!value) return undefined;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > max ? decoded.slice(0, max) : decoded;
  } catch {
    return undefined;
  }
};

/** A numeric header, with anything unusable read as an unset coordinate. */
const headerNumber = (value: string | null): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

export class BrowserService {
  private readonly queues = new Map<string, Promise<unknown>>();
  private health?: { checkedAt: number; reachable: Promise<boolean> };
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {}
  /** Whether the configured worker answers its health check, cached briefly for snapshots. */
  reachable(): Promise<boolean> {
    if (!this.config.workerUrl || !this.config.workerToken) return Promise.resolve(false);
    const now = this.now();
    if (this.health && now - this.health.checkedAt < 15_000) return this.health.reachable;
    const reachable = fetch(`${this.config.workerUrl}/health`, {
      signal: AbortSignal.timeout(2000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    this.health = { checkedAt: now, reachable };
    return reachable;
  }
  private async serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.queues.set(id, next);
    try {
      return await next;
    } finally {
      if (this.queues.get(id) === next) this.queues.delete(id);
    }
  }
  private async request(path: string, body?: unknown, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.config.workerUrl || !this.config.workerToken)
      throw new AppError("Browser worker is not configured. Start it using the setup guide.", 503);
    let response: Response;
    try {
      response = await fetch(`${this.config.workerUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.workerToken}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(45000)])
          : AbortSignal.timeout(45000),
      });
    } catch {
      signal?.throwIfAborted();
      throw new AppError(
        "Browser worker is unavailable. Check that its container is running.",
        503,
      );
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new AppError(
        typeof payload?.error?.message === "string"
          ? payload.error.message
          : "Browser request failed",
        502,
      );
    }
    return response;
  }
  async get(owner: string, id: string) {
    const value = await this.db.get<BrowserSession>(owner, "browsers", id);
    if (!value) throw new AppError("Browser session not found", 404);
    return value;
  }
  decorate(owner: string, session: BrowserSession) {
    return {
      ...session,
      consoleUrl: this.auth.sign(owner, `/api/browsers/${session.id}/console`),
      previewUrl: this.auth.sign(owner, `/api/browsers/${session.id}/preview`),
    };
  }
  private async save(owner: string, payload: unknown, expectedId: string) {
    const session = sessionSchema.parse(payload);
    if (session.id !== expectedId)
      throw new AppError("Browser worker returned a different session", 502);
    await this.db.put(owner, "browsers", session);
    return this.decorate(owner, session);
  }
  async create(owner: string, url: string) {
    const id = randomUUID();
    // Record ownership before calling the worker, including when its response is lost.
    await this.db.put(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.reopen(owner, id, url);
  }
  private async openOwned(owner: string, id: string, url?: string, signal?: AbortSignal) {
    const value = await this.get(owner, id);
    const target = url ?? value.url;
    try {
      const response = await this.request("/sessions", { id, url: target }, signal);
      return await this.save(owner, await response.json(), id);
    } catch (error) {
      await this.save(
        owner,
        { ...value, url: target, status: "error", updatedAt: new Date().toISOString() },
        id,
      );
      throw error;
    }
  }
  reopen(owner: string, id: string, url?: string) {
    return this.serial(id, () => this.openOwned(owner, id, url));
  }
  navigate(owner: string, id: string, url: string) {
    return this.reopen(owner, id, url);
  }
  private async readOwned(owner: string, id: string, signal?: AbortSignal) {
    const session = await this.get(owner, id);
    const result = readSchema.parse(
      await (await this.request(`/sessions/${id}/read`, undefined, signal)).json(),
    );
    await this.save(
      owner,
      {
        ...session,
        url: result.url,
        title: result.title,
        status: "active",
        updatedAt: new Date().toISOString(),
      },
      id,
    );
    return result;
  }
  read(owner: string, id: string) {
    return this.serial(id, () => this.readOwned(owner, id));
  }
  /**
   * Reads the page as an addressable model: text plus the elements the agent may act on.
   * This is the observation every element-addressed action depends on, so it is
   * serialised on the same session queue as input to keep refs and actions in order.
   */
  snapshot(owner: string, id: string, signal?: AbortSignal) {
    return this.serial(id, async () => {
      const session = await this.get(owner, id);
      const result = snapshotSchema.parse(
        await (await this.request(`/sessions/${id}/snapshot`, undefined, signal)).json(),
      );
      await this.save(
        owner,
        {
          ...session,
          url: result.url,
          title: result.title,
          status: "active",
          updatedAt: new Date().toISOString(),
        },
        id,
      );
      return result;
    });
  }
  /**
   * Runs a web search through the worker's browser. It borrows the session only to reach
   * the search page, so it is serialised like every other operation on that session; the
   * agent then opens any result it wants with read_web.
   */
  async search(owner: string, id: string, query: string, signal?: AbortSignal) {
    await this.get(owner, id);
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      return searchSchema.parse(
        await (await this.request("/search", { id, query }, signal)).json(),
      );
    });
  }
  async observe(owner: string, url: string, existingId?: string) {
    const id = existingId ?? (await this.create(owner, url)).id;
    return this.serial(id, async () => {
      if (existingId) await this.openOwned(owner, id, url);
      return { sessionId: id, ...(await this.readOwned(owner, id)) };
    });
  }
  async observeForThread(owner: string, threadId: string, url: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    // Persist the association before contacting the worker so failed/lost responses
    // and later chat turns keep using the same profile instead of exhausting its limit.
    const association =
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId)) ??
      (await this.db.insertIfAbsent(owner, "chat-browsers", {
        id: threadId,
        sessionId: randomUUID(),
      })) ??
      (await this.db.get<ChatBrowser>(owner, "chat-browsers", threadId));
    if (!association) throw new AppError("Could not reserve the chat browser session", 500);
    const id = association.sessionId;
    await this.db.insertIfAbsent(owner, "browsers", {
      id,
      url,
      title: "New browser session",
      status: "idle",
      updatedAt: new Date().toISOString(),
    });
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      await this.openOwned(owner, id, url, signal);
      signal?.throwIfAborted();
      const page = await this.readOwned(owner, id, signal);
      signal?.throwIfAborted();
      return {
        sessionId: id,
        ...page,
        text: page.text.slice(0, 30_000),
        truncated: page.truncated || page.text.length > 30_000,
      };
    });
  }
  async close(owner: string, id: string) {
    return this.serial(id, async () => {
      await this.get(owner, id);
      return this.save(owner, await (await this.request(`/sessions/${id}/close`, {})).json(), id);
    });
  }
  async preview(owner: string, id: string) {
    await this.get(owner, id);
    return this.request(`/sessions/${id}/screenshot`);
  }
  async input(
    owner: string,
    id: string,
    value: unknown,
    options: { signal?: AbortSignal; read?: boolean } = {},
  ) {
    // Validated here so a bad payload never costs a worker round trip. The worker would
    // answer the same request with this message; keeping the wording identical means the
    // takeover console shows one stable error either way.
    const parsed = browserWireInputSchema.safeParse(value);
    if (!parsed.success) throw new AppError(UNSUPPORTED_INPUT_MESSAGE, 400);
    return this.serial(id, async () => {
      await this.get(owner, id);
      options.signal?.throwIfAborted();
      const session = await this.save(
        owner,
        await (await this.request(`/sessions/${id}/input`, parsed.data, options.signal)).json(),
        id,
      );
      // The worker answers an input with refreshed session metadata only. Re-reading
      // inside the same serialised block gives the caller the grounding read_web returns,
      // without racing another operation on the same session.
      const page = options.read ? await this.readOwned(owner, id, options.signal) : undefined;
      return { session, page };
    });
  }
  /**
   * Opens, switches, closes or lists the session's tabs. Serialised like every other
   * operation on that session, so a tab switch cannot interleave with an action that was
   * aimed at the tab the agent was on a moment ago.
   */
  async tabs(
    owner: string,
    id: string,
    action: "list" | "open" | "switch" | "close",
    options: { index?: number; url?: string; signal?: AbortSignal } = {},
  ) {
    await this.get(owner, id);
    return this.serial(id, async () => {
      options.signal?.throwIfAborted();
      const result = tabsSchema.parse(
        await (
          await this.request(
            "/tabs",
            {
              id,
              action,
              index: options.index,
              url: options.url,
            },
            options.signal,
          )
        ).json(),
      );
      // The active tab is what a later action lands on, so the session follows it.
      const active = result.tabs[result.active];
      if (active) {
        const stored = await this.get(owner, id);
        await this.save(
          owner,
          { ...stored, url: active.url, title: active.title, status: "active" },
          id,
        );
      }
      return result;
    });
  }
  /**
   * One frame of the agent's browser, for the live mirror.
   *
   * Ownership is checked before anything is captured, exactly as for every other
   * read of this session: a mirror socket must not become a way to watch a
   * browser belonging to somebody else.
   */
  async frame(owner: string, id: string, signal?: AbortSignal): Promise<BrowserFrame> {
    await this.get(owner, id);
    // Serialised on the session queue so a mirror at 4fps cannot interleave with
    // the very action the person is watching.
    return this.serial(id, async () => {
      signal?.throwIfAborted();
      const response = await this.request(`/sessions/${id}/frame`, undefined, signal);
      const jpeg = new Uint8Array(await response.arrayBuffer());
      return {
        jpeg,
        cursor: {
          x: headerNumber(response.headers.get("x-openmuse-cursor-x")),
          y: headerNumber(response.headers.get("x-openmuse-cursor-y")),
        },
        url: headerText(response.headers.get("x-openmuse-url"), 2000),
        title: headerText(response.headers.get("x-openmuse-title"), 300),
      };
    });
  }

  async imports(owner: string, id: string) {
    await this.get(owner, id);
    const { downloads, failures } = z
      .object({
        downloads: z.array(
          z.object({ id: z.string(), name: z.string(), size: z.number(), mimeType: z.string() }),
        ),
        failures: z.array(failureSchema),
      })
      .parse(await (await this.request(`/sessions/${id}/downloads`)).json());
    const saved = [];
    for (const download of downloads) {
      const existing = await this.db.get<{ fileId: string }>(
        owner,
        "browser-downloads",
        download.id,
      );
      if (existing) {
        saved.push(this.files.signed(owner, await this.files.get(owner, existing.fileId)));
        continue;
      }
      const response = await this.request(
        `/sessions/${id}/downloads/${encodeURIComponent(download.id)}`,
      );
      const file = await this.files.import(
        owner,
        download.name,
        new Uint8Array(await response.arrayBuffer()),
        `Browser · ${id}`,
      );
      await this.db.put(owner, "browser-downloads", { id: download.id, fileId: file.id });
      saved.push(file);
    }
    return { files: saved, failures };
  }
  console(owner: string, id: string) {
    return browserConsole(this.auth.sign(owner, `/api/browsers/${id}/preview`));
  }
}
