/**
 * The page model the agent reasons over. A snapshot carries the readable text and the
 * elements it may address, so an action names a target instead of guessing a pixel.
 *
 * Refs are stamped onto the live document, which is what lets a later action resolve
 * them. They deliberately do not survive a real navigation: the elements carrying them
 * are replaced along with the document, so a stale ref fails loudly at the worker
 * instead of silently landing on something else.
 */

export const MAX_ELEMENTS = 200;
export const MAX_LINKS = 300;
export const MAX_NAME = 120;
export const MAX_OPTIONS = 50;
export const MAX_SEARCH_RESULTS = 20;
export const MAX_TEXT = 100_000;
/** A search query is bounded like other free text so one call cannot flood a page. */
export const MAX_QUERY = 300;
export const REF_ATTRIBUTE = "data-openmuse-ref";
/** `e1` through `e999`. The real ceiling is MAX_ELEMENTS, checked where a ref is used. */
export const REF_PATTERN = /^e[1-9][0-9]{0,2}$/;

/** The ordinal a ref carries, or 0 when it is not a well-formed ref. */
export function refNumber(ref: string): number {
  return REF_PATTERN.test(ref) ? Number(ref.slice(1)) : 0;
}

export type PageRole = "link" | "button" | "textbox" | "checkbox" | "radio" | "combobox";

export interface PageElement {
  ref: string;
  role: PageRole;
  name: string;
  /** Present on text fields. Never set for a password field, whatever it contains. */
  value?: string;
  /** A password field is described so the agent can route to the user, not filled. */
  password?: boolean;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
  options?: string[];
}

export interface PageLink {
  text: string;
  href: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: PageElement[];
  links: PageLink[];
}

export interface SnapshotLimits {
  maxElements: number;
  maxLinks: number;
  maxName: number;
  maxOptions: number;
  maxText: number;
}

/** The limits a snapshot is taken under. */
export function snapshotLimits(): SnapshotLimits {
  return {
    maxElements: MAX_ELEMENTS,
    maxLinks: MAX_LINKS,
    maxName: MAX_NAME,
    maxOptions: MAX_OPTIONS,
    maxText: MAX_TEXT,
  };
}
/**
 * Runs inside the page. It is deliberately self-contained: callers cannot inject
 * JavaScript, and every limit arrives as an argument so this body holds no reference
 * that would vanish when the function is serialized.
 */
export function snapshotScript(limits: SnapshotLimits) {
  const refAttribute = "data-openmuse-ref";
  const clean = (value: string | null | undefined, max: number) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const shown = (element: Element) => {
    const box = element.getBoundingClientRect();
    // A rendered element keeps its box while scrolled far off-screen, which is what we
    // want: a link below the fold is still a target. Collapsed and hidden ones are not.
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
  };

  // Password fields are described so the agent can see that a form needs one, but their
  // value is never read: the worker refuses to fill them, and returning it would defeat
  // that. Credential entry stays with the user through the takeover console.
  const fieldName = (element: Element) => {
    const labelled = element.getAttribute("aria-label");
    if (labelled) return clean(labelled, limits.maxName);
    const placeholder = element.getAttribute("placeholder");
    if (placeholder) return clean(placeholder, limits.maxName);
    const id = element.getAttribute("id");
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label?.textContent) return clean(label.textContent, limits.maxName);
    }
    const wrapper = element.closest("label");
    if (wrapper?.textContent) return clean(wrapper.textContent, limits.maxName);
    const text = (element as HTMLElement).innerText || element.textContent || "";
    return clean(text, limits.maxName);
  };

  const roleOf = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role");
    if (["link", "button", "textbox", "checkbox", "radio", "combobox"].includes(explicit ?? ""))
      return explicit ?? undefined;
    const tag = element.tagName;
    if (tag === "A") return element.hasAttribute("href") ? "link" : undefined;
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "INPUT") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (["password", "text", "email", "search", "url", "tel", "number"].includes(type))
        return "textbox";
      return undefined;
    }
    if (element.getAttribute("contenteditable") === "true") return "textbox";
    return undefined;
  };

  // Refs from an earlier snapshot would otherwise pile up on the page and let a ref
  // outlive the model that was shown it, so each snapshot starts from a clean document.
  for (const stale of Array.from(document.querySelectorAll(`[${refAttribute}]`)))
    stale.removeAttribute(refAttribute);

  const elements: PageElement[] = [];
  const candidates = document.querySelectorAll(
    "a[href], button, summary, select, textarea, input, [role=button], [role=link], [role=textbox], [role=checkbox], [role=radio], [role=combobox], [contenteditable=true]",
  );
  for (const element of Array.from(candidates)) {
    if (elements.length >= limits.maxElements) break;
    if (!shown(element)) continue;
    const role = roleOf(element);
    if (!role) continue;
    // An unnamed control tells the agent nothing it could act on, so it costs no ref.
    const name = fieldName(element);
    if (!name) continue;
    const tag = element.tagName.toLowerCase();
    const type = tag === "input" ? (element.getAttribute("type") ?? "text").toLowerCase() : "";
    const ref = `e${elements.length + 1}`;
    element.setAttribute(refAttribute, ref);
    const entry: PageElement = { ref, role: role as PageElement["role"], name };
    if (tag === "input" || tag === "textarea") {
      if (type === "password") entry.password = true;
      else {
        const value = clean((element as HTMLInputElement).value, limits.maxName);
        if (value) entry.value = value;
      }
    }
    if (tag === "input" && (type === "checkbox" || type === "radio"))
      entry.checked = (element as HTMLInputElement).checked;
    if (element.hasAttribute("disabled") || (element as HTMLInputElement).disabled)
      entry.disabled = true;
    if (tag === "a") {
      const href = clean(element.getAttribute("href"), 2000);
      if (href) entry.href = href;
    }
    if (role === "combobox") {
      const options: string[] = [];
      for (const option of Array.from((element as HTMLSelectElement).options)) {
        if (options.length >= limits.maxOptions) break;
        const label = clean(option.label || option.text, limits.maxName);
        if (label) options.push(label);
      }
      if (options.length) entry.options = options;
    }
    elements.push(entry);
  }

  const links: PageLink[] = [];
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    if (links.length >= limits.maxLinks) break;
    if (!shown(anchor)) continue;
    const href = clean(anchor.getAttribute("href"), 2000);
    if (href) links.push({ text: fieldName(anchor), href });
  }

  const text = document.body?.innerText ?? "";
  return {
    url: location.href,
    title: (document.title ?? "").slice(0, 300),
    text: text.slice(0, limits.maxText),
    truncated: text.length > limits.maxText,
    elements,
    links,
  };
}
/**
 * Search-result extraction for the worker's own query page. Kept beside the snapshot
 * script so both in-page evaluations follow one set of conventions.
 */
export function searchResultsScript(maxResults: number) {
  const clean = (value: string | null | undefined, max: number) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const results: { title: string; href: string; snippet: string }[] = [];
  for (const block of Array.from(
    document.querySelectorAll("div.result, div.web-result, article[data-testid='result']"),
  )) {
    if (results.length >= maxResults) break;
    const anchor = block.querySelector("a.result__a, h2 a, a[href]");
    const href = clean(anchor?.getAttribute("href"), 2000);
    if (!anchor || !href) continue;
    const snippet = block.querySelector(".result__snippet, [data-result='snippet']");
    results.push({
      title: clean(anchor.textContent, 300) || href,
      href,
      snippet: clean(snippet?.textContent, 600),
    });
  }
  return results;
}

/**
 * Unwraps the redirect wrapper a search engine puts around outbound links, so the agent
 * receives the destination the user would actually reach. A link that stays wrapped, or
 * that does not decode to a public web address, is dropped rather than guessed at.
 */
export function unwrapResultHref(raw: string): string | undefined {
  let candidate = raw.trim();
  if (/^\/\//.test(candidate)) candidate = `https:${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  const wrapped = parsed.searchParams.get("uddg") ?? parsed.searchParams.get("url");
  if (wrapped) {
    try {
      parsed = new URL(wrapped);
    } catch {
      return undefined;
    }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return parsed.href;
}
