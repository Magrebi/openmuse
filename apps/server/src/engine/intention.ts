/**
 * Turning a tool call into the one line a person should see while it runs.
 *
 * The tool's `description` is written for the *model* choosing between tools, so
 * it is a sentence about capability: "Open and read a public webpage." Shown in
 * the UI verbatim that reads as documentation rather than progress, and it is
 * identical for every call to the same tool — so a run that reads five pages
 * shows the same line five times.
 *
 * What a person wants is the specific intention: which page, which query. So the
 * tool name selects a template and the arguments fill it. Anything unrecognised
 * returns nothing, and the caller falls back to the description, which is always
 * at least accurate — a wrong line is worse than a generic one.
 *
 * Kept in its own module so it can be tested exhaustively without constructing a
 * whole agent runtime.
 */

/** Longest a quoted argument may be inside a headline. */
const MAX_ARGUMENT = 60;

/** Longest a hostname may be. */
const MAX_HOST = 48;

const text = (values: Record<string, unknown>, key: string, max: number): string | undefined => {
  const value = values[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
};

/**
 * The hostname of a URL argument, for display.
 *
 * A hostname is what a person recognises; a full path with a tracking query is
 * noise. A URL that will not parse falls back to its own text, because a tool
 * can legitimately be handed something that is not yet a valid URL.
 */
const host = (values: Record<string, unknown>, key = "url"): string | undefined => {
  const raw = text(values, key, 400);
  if (!raw) return undefined;
  try {
    const name = new URL(raw).hostname.replace(/^www\./, "");
    return name.length > MAX_HOST ? `${name.slice(0, MAX_HOST - 1)}…` : name;
  } catch {
    return raw.slice(0, MAX_HOST);
  }
};

/**
 * The micro-intention for a tool call, or `undefined` when the tool is unknown.
 */
export const intentionFor = (name: string, rawArgs: unknown): string | undefined => {
  const values = (typeof rawArgs === "object" && rawArgs !== null ? rawArgs : {}) as Record<
    string,
    unknown
  >;
  switch (name) {
    case "search_web": {
      const query = text(values, "query", MAX_ARGUMENT);
      return query ? `🔍 Searching for “${query}”` : "🔍 Searching the web";
    }
    case "read_web": {
      const site = host(values);
      return site ? `📄 Reading ${site}` : "📄 Reading a page";
    }
    case "browser_snapshot":
      return "🔍 Reading the page and its controls";
    case "browser_click":
      return "👆 Clicking a control";
    case "browser_fill":
      return "⌨️ Filling a field";
    case "browser_type":
      return "⌨️ Typing into the page";
    case "browser_select":
      return "▾ Choosing an option";
    case "browser_check":
      return "☑️ Setting a checkbox";
    case "browser_scroll":
      return "↕️ Scrolling the page";
    case "browser_key":
      return "⌨️ Pressing a key";
    case "browser_back":
      return "↩️ Going back";
    case "browser_wait":
      return "⏳ Letting the page finish loading";
    case "browser_tabs":
      return "🗂️ Switching tabs";
    case "browser_upload":
      return "📎 Uploading a file";
    case "inspect_pdf":
      return "📄 Inspecting a document";
    case "read_pdf":
      return "📄 Reading a document";
    case "fill_pdf":
      return "✍️ Filling a document";
    case "prepare_email":
      return "✍️ Drafting a reply";
    case "prepare_event":
      return "📅 Preparing a calendar change";
    case "search_mail":
      return "🔍 Searching your mail";
    case "read_mail_thread":
      return "📧 Reading a conversation";
    case "computer_screenshot":
      return "🖥 Looking at the computer";
    case "finish_task":
      return "📝 Writing up the result";
    case "ask_user":
      return "✋ Waiting for your input";
    case "save_artifact":
      return "💾 Saving what was found";
    default:
      return undefined;
  }
};
