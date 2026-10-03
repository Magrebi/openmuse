import { z } from "zod";

/**
 * Agent-operated browser input. Every bound here mirrors the worker so the model is
 * refused before a round trip, and the worker stays the final authority on its own
 * endpoints (apps/worker/src/browser.ts).
 */

/** The worker screenshots at 1280x800 and accepts clicks inside that space. */
export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 800;
export const MAX_INPUT_TEXT = 10_000;
export const MAX_SCROLL = 5000;
/** Keep in sync with the worker's key whitelist. */
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
/** Input actions allowed per delegated task, durable across resumed runs. */
export const BROWSER_INPUT_BUDGET = 25;
/**
 * The rejection the worker raises for an unusable payload. The server validates first and
 * raises the same wording so the takeover console shows one stable message instead of a
 * raw schema error. A test asserts this stays identical to the worker's own message.
 */
export const UNSUPPORTED_INPUT_MESSAGE = "Unsupported browser input or coordinates.";

export const scrollInputSchema = z.object({
  deltaY: z.number().min(-MAX_SCROLL).max(MAX_SCROLL),
});
export const keyInputSchema = z.object({ key: z.enum(INPUT_KEYS) });
export const clickInputSchema = z.object({
  x: z
    .number()
    .min(0)
    .max(SCREEN_WIDTH - 1),
  y: z
    .number()
    .min(0)
    .max(SCREEN_HEIGHT - 1),
});
export const typeInputSchema = z.object({
  text: z.string().min(1).max(MAX_INPUT_TEXT),
});

export type BrowserInputKind = "click" | "text" | "key" | "scroll";

/**
 * The worker's `POST /sessions/{id}/input` contract, mirroring its own bounds so a bad
 * payload is refused here instead of costing a round trip. The worker revalidates and
 * remains the final authority.
 */
export const browserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("click"),
    x: z
      .number()
      .min(0)
      .max(SCREEN_WIDTH - 1),
    y: z
      .number()
      .min(0)
      .max(SCREEN_HEIGHT - 1),
  }),
  z.object({ type: z.literal("text"), text: z.string().min(1).max(MAX_INPUT_TEXT) }),
  z.object({ type: z.literal("key"), key: z.enum(INPUT_KEYS) }),
  z.object({ type: z.literal("scroll"), deltaY: z.number().min(-MAX_SCROLL).max(MAX_SCROLL) }),
]);
export type BrowserInputPayload = z.output<typeof browserInputSchema>;

export function originOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function urlTokens(url: string): string[] {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname} ${parsed.search}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

// A submit that spends money or commits a booking needs its own approval, exactly like
// prepare_email and prepare_event do for mail and calendar.
const TRANSACTIONAL = new Set([
  "checkout",
  "checkouts",
  "payment",
  "payments",
  "billing",
  "purchase",
  "purchases",
  "confirm",
  "confirmation",
  "placeorder",
  "confirmorder",
  "orderconfirmation",
  "orderreview",
  "ordersummary",
  "reservation",
  "reservations",
  "booking",
  "bookings",
  "bookingconfirmation",
]);

/**
 * Whether the page now looks like a transaction the agent must not complete alone.
 * A false positive only pauses the task for the user; a false negative is the real risk,
 * so the list stays deliberately broad — but each pattern must stand on its own, or an
 * article about confirmation bias would halt a research task.
 */
export function looksTransactional(url: string, title: string): boolean {
  if (urlTokens(url).some((token) => TRANSACTIONAL.has(token))) return true;
  return TRANSACTIONAL_TITLE.test(title);
}

const TRANSACTIONAL_TITLE =
  /\bcheck ?out\b|\bpay(?:ment|ing)?\b|\bbilling\b|\bpurchas(?:e|es|ed|ing)\b|\bbuy now\b|\badd to (?:cart|bag|basket)\b|\bplace order\b|\border (?:summary|confirmation|total|details)\b|\bconfirm\w*\b[^.]{0,40}\border\b|\breservations?\b|\bbookings?\b/i;

const CREDENTIAL_TOKENS = new Set([
  "login",
  "signin",
  "signup",
  "register",
  "password",
  "passwords",
  "reset",
  "auth",
  "mfa",
  "otp",
]);

/** Whether the page is asking the visitor to authenticate. */
export function looksCredentialed(url: string, title: string): boolean {
  if (urlTokens(url).some((token) => CREDENTIAL_TOKENS.has(token))) return true;
  return /sign in|log in|login|create an account|reset password|verification code/i.test(title);
}
// An assignment shape keeps ordinary prose ("the page asks for a password reset") from
// being read as a secret while still catching a real value being handed over. Words that
// merely appear in ordinary product text ("auth: none", "secret garden") are left out.
const SECRET_ASSIGNMENT =
  /(?:password|passcode|passphrase|api[\s_-]?key|cvv|cvc|security code|one[\s-]?time|otp|token|secret)\s*(?:is|=|:|=>)\s*\S+/i;
const BEARER = /\bbearer\s+\S{16,}/i;
const JWT = /ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
/** A long unbroken run with no sentence structure is usually an opaque credential. */
const LONG_BLOB = /^[A-Za-z0-9+/=_-]{40,}$/;

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function looksLikeCard(text: string): boolean {
  const groups = text.match(/(?:\d[ -]?){12,22}\d/g) ?? [];
  return groups.some((group) => {
    const digits = group.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
  });
}

/**
 * Best-effort rejection of credentials and payment details. This is defence in depth,
 * not a security boundary: a model cannot be trusted to self-report, so anything
 * sign-in shaped still routes to the takeover console regardless of this result.
 */
export function containsSecret(text: string): boolean {
  if (JWT.test(text)) return true;
  if (looksLikeCard(text)) return true;
  if (LONG_BLOB.test(text.trim())) return true;
  return SECRET_ASSIGNMENT.test(text) || BEARER.test(text);
}

export interface BrowserInputState {
  [key: string]: unknown;
  browserId?: string;
  browserOrigin?: string;
  browserLastUrl?: string;
  browserFrozen?: boolean;
  browserInputSpent?: number;
  browserInputUncertain?: string;
}

function stringField(state: Record<string, unknown>, key: string): string | undefined {
  const value = state[key];
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Clearing marker for `browserInputUncertain`. Task state is merged as JSONB, so a key
 * can only be overwritten, never deleted; an empty string reads back as "not set".
 */
const UNCLEARED = "";

/**
 * Per-task guardrail state, rebuilt from the checkpointed task state on every resumed
 * run so a freeze and the action budget both survive restarts.
 *
 * Every mutating method returns only the browser fields it owns. The caller merges those
 * over the live task state; returning a whole snapshot would revert anything another tool
 * persisted since this guard was built.
 */
export class BrowserInputGuard {
  private origin?: string;
  private frozen: boolean;
  private spent: number;
  private lastUrl?: string;
  private sessionId?: string;
  private uncertainReason?: string;

  constructor(state: Record<string, unknown> = {}) {
    this.sessionId = stringField(state, "browserId");
    this.origin = stringField(state, "browserOrigin");
    this.lastUrl = stringField(state, "browserLastUrl");
    this.frozen = state.browserFrozen === true;
    this.spent = typeof state.browserInputSpent === "number" ? state.browserInputSpent : 0;
    this.uncertainReason = stringField(state, "browserInputUncertain");
  }

  /** The session the agent is allowed to operate, set by the first observation. */
  get browserId(): string | undefined {
    return this.sessionId;
  }

  get remaining(): number {
    return Math.max(0, BROWSER_INPUT_BUDGET - this.spent);
  }

  get isFrozen(): boolean {
    return this.frozen;
  }

  /** Whether an earlier input ended in an unknown state that must be re-read first. */
  get isUncertain(): boolean {
    return this.uncertainReason !== undefined;
  }

  /** The last URL this session was known to be on, for receipt urlBefore. */
  get urlBefore(): string | undefined {
    return this.lastUrl;
  }

  /** Records an observation and re-arms the session for the origin it is on. */
  adopt(sessionId: string, url: string): BrowserInputState {
    this.sessionId = sessionId;
    this.origin = originOf(url);
    this.lastUrl = url;
    this.frozen = false;
    // Reading the page is how an unknown outcome is resolved, so it clears the pause.
    this.uncertainReason = undefined;
    return {
      browserId: sessionId,
      browserOrigin: this.origin,
      browserLastUrl: url,
      browserFrozen: false,
      browserInputUncertain: UNCLEARED,
    };
  }

  /** Refuses a paused or exhausted session before any worker call is made. */
  begin(): void {
    // Without this a model could keep retrying an input whose outcome is unknown, and the
    // action budget never advances for a failed attempt, so nothing would bound it.
    if (this.uncertainReason)
      throw new Error(
        `The last browser input (${this.uncertainReason}) has an unknown outcome, so this session is paused for further input. Read the page again with read_web to see what actually happened.`,
      );
    if (this.frozen)
      throw new Error(
        "This browser session left the site it started on, so interactive input is frozen. Read the page again with read_web, or ask the user to take control of the session.",
      );
    if (this.remaining <= 0)
      throw new Error(
        `This task used all ${BROWSER_INPUT_BUDGET} browser input actions. Report what you found and ask the user to continue from the takeover console.`,
      );
  }

  /** Spends one action and freezes the session when the page left its origin. */
  complete(urlAfter: string): BrowserInputState {
    this.spent++;
    this.uncertainReason = undefined;
    const next = originOf(urlAfter);
    // Leaving the observed public origin is out of scope. A page that is not a web origin
    // at all (about:blank, data:, file:) cannot be compared, so it counts as leaving too.
    if (this.origin === undefined || next !== this.origin) this.frozen = true;
    if (next) this.origin = next;
    this.lastUrl = urlAfter;
    return {
      browserId: this.browserId,
      browserOrigin: this.origin,
      browserLastUrl: urlAfter,
      browserFrozen: this.frozen,
      browserInputSpent: this.spent,
      browserInputUncertain: UNCLEARED,
    };
  }

  /**
   * Records an input whose outcome is unknown. It is surfaced and never replayed, and it
   * pauses further input until the agent re-reads the page.
   */
  uncertain(action: BrowserInputKind, detail: string): BrowserInputState {
    this.uncertainReason = `${action}: ${detail}`;
    return { browserInputUncertain: this.uncertainReason };
  }
}
