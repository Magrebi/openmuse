/**
 * Every network call the app makes goes through here.
 *
 * A bare `fetch` never rejects on its own: if the API stops responding — the
 * server was stopped, the machine slept, or the connection is held open — the
 * promise stays pending forever. The polling screens reset their "busy" flag in
 * a `finally`, so one pending request silently stops polling forever and the UI
 * shows stale data with no error at all. Bounding every request turns that hang
 * into a message the person can act on.
 *
 * This module deliberately has no React Native import, so the behaviour can be
 * tested under plain Node.
 */

/** Long enough for a slow read of a real page, short enough to feel immediate. */
export const requestTimeoutMs = 20_000;

/** Shown when the API does not answer in time. Never a stack trace. */
export const unreachableMessage =
  "OpenMuse is not responding. Check that it is running, then try again.";

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  /** Override for a request that legitimately takes longer, such as an export. */
  timeoutMs?: number;
}

/**
 * `fetch` with a hard deadline. The timer is always cleared, so a completed
 * request leaves nothing behind to fire later.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestOptions = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? requestTimeoutMs);
  try {
    return await fetchImpl(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
  } catch (error) {
    // A caller-supplied abort is not a timeout, so it keeps its own reason.
    if (!controller.signal.aborted) throw error;
    throw new Error(unreachableMessage);
  } finally {
    clearTimeout(timer);
  }
}

/** True when a request failed because the API could not be reached. */
export const isUnreachable = (error: unknown): boolean =>
  error instanceof Error && error.message === unreachableMessage;
