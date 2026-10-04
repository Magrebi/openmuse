import { AppError, OutcomeUnknownError } from "./errors.ts";

/**
 * CasaOS API client, CasaOS 0.4.9.
 *
 * Curl-verified against the real host from the LAN (this sandbox cannot
 * reach it, so re-verify from the LAN after network changes):
 * - POST /v1/users/login {username,password} -> {"success":200,"message":"ok",
 *   "data":{"token":{"access_token":"<jwt>","refresh_token":"..."}}}
 * - Auth header: raw JWT, NO "Bearer" prefix.
 * - GET /v2/app_management/web/appgrid -> {"data":[{"name","port","status","..."}]}.
 *   v2 endpoints have NO `success` field: judge by HTTP status + presence of `data`.
 * - GET /v1/sys/utilization -> {"success":200,"message":"ok","data":{cpu:{percent,temperature},mem:{usedPercent},net}}
 *   (top-level shape verified; `net` is a live-verified ARRAY of
 *   {name,bytesSent,bytesRecv,...} cumulative counters — see systemUtilization).
 *
 * Still open (host-test when possible):
 * - `?lines=` support on the compose logs endpoint.
 *
 * Live-verified 2026-10-01 additions:
 * - `net` fields are bytesSent/bytesRecv (cumulative counters per interface).
 * - appgrid `status` values observed: "running", "exited"; one entry had no
 *   status key at all (mapped to "unknown").
 *
 * Other endpoint shapes (per 0.4.9 expectations):
 * - GET /v2/app_management/compose/{app} -> {"data":{"compose":{"services":{...}}}}
 * - GET /v2/app_management/compose/{app}/logs -> {"data":"<log text>"}
 * - PUT /v2/app_management/compose/{app}/status body: raw JSON string
 *   "start"|"stop"|"restart" (objects are rejected); the change is async.
 *
 * Security: the password only ever goes to /v1/users/login. Credentials live in
 * encrypted storage and are loaded per call via `loadCredentials`. This module
 * does not intentionally include credentials in logs, errors, API responses,
 * or tool results. Log output is redacted and truncated.
 */

export interface CasaOSCredentials {
  username: string;
  password: string;
  connectionId: string;
}

export interface CasaOSAppEntry {
  name: string;
  port?: string;
  status: string;
}

export interface CasaOSServiceInfo {
  service: string;
  image?: string;
  container_name?: string;
}

export interface CasaOSAppDetail extends CasaOSAppEntry {
  services: CasaOSServiceInfo[];
}

export interface CasaOSAppLogs {
  lines: string[];
  truncated: boolean;
  redacted: boolean;
}

export interface CasaOSSystemStatus {
  cpu_percent?: number;
  cpu_temperature_c?: number;
  memory_used_percent?: number;
  network_up_bytes?: number;
  network_down_bytes?: number;
}

const LOGIN_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;
const PUT_TIMEOUT_MS = 15_000;
// Short-lived appgrid cache: getApp() would otherwise fetch the list twice
// (once directly, once via validateApp). Poll loops bypass it with refresh=true.
const APPGRID_CACHE_TTL_MS = 8_000;
const LOG_READ_CAP_BYTES = 1_000_000; // 1MB of log text kept (the tail) after redaction
const LOG_BODY_CAP_BYTES = 2_000_000; // 2MB absolute cap on the raw log response body
const LOG_TAIL_BYTES = 8_000; // 8KB tail after redaction
const LOGIN_BODY_CAP_BYTES = 64_000; // 64KB cap on login response bodies
const JSON_BODY_CAP_BYTES = 512_000; // 512KB cap on appgrid/compose/utilization bodies

// Strict allowlist for app names before they are placed into a URL path.
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9_.-]*$/;

function notConnectedError(): AppError {
  return new AppError(
    "CasaOS is not connected or its saved credentials cannot be read. Reconnect CasaOS in the OpenMuse UI (Connections → CasaOS).",
    409,
  );
}

/**
 * Throws when the app name must never be touched, even with approval.
 * Called at proposal time AND at execution time.
 */
export function assertCasaOSAppAllowed(protectedApps: string[], app: string): void {
  const normalized = app.trim().toLowerCase();
  if (protectedApps.includes(normalized) || normalized.startsWith("openmuse-"))
    throw new AppError(
      `CasaOS app "${normalized}" is protected: it hosts OpenMuse or its network access and cannot be started, stopped or restarted.`,
      403,
    );
}

/**
 * Best-effort secret scrubbing for log text. Not a guarantee.
 *
 * CPU note: the patterns below are linear-time ONLY on bounded input.
 * Callers must run capLogLines() first (the log pipeline does): without a
 * per-line cap, pathological lines (long whitespace runs, dot-runs, token
 * runs — all plausible in attacker-influenced log content like torrent names
 * or User-Agent strings) make some of these patterns take quadratic time and
 * freeze single-threaded Node.
 */
export function redactCasaOSLogs(text: string): string {
  let out = redactUrlUserinfo(text);
  const patterns: Array<[RegExp, string]> = [
    // Secret-looking query-string / fragment parameters:
    // ?token=, &api_key=, #access_token=
    // The name classes are bounded ({0,64}) so a megabyte-long token run
    // cannot make the lazy prefix scan quadratic.
    [
      /([?&#][\w.-]{0,64}?(?:api[_-]?key|secret|token|password|passwd|pwd)[\w.-]{0,64}=)([^&\s"'#]+)/gi,
      "$1[redacted]",
    ],
    // Bearer tokens
    [/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer [redacted]"],
    [/Authorization:\s*[^\r\n]+/gi, "Authorization: [redacted]"],
    // API keys / JWTs
    [/\bsk-[A-Za-z0-9\-_]{8,}\b/g, "[redacted-api-key]"],
    [/\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, "[redacted-jwt]"],
    // Provider-issued token formats (best-effort)
    [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[redacted-token]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[redacted-token]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-token]"],
    // Cookie / Set-Cookie header values (leading whitespace tolerated).
    // [ \t]* only: \s* would cross line boundaries and backtrack
    // quadratically on long whitespace/newline runs.
    [/^([ \t]*(?:Cookie|Set-Cookie))[ \t]*:[ \t]*\S.*$/gim, "$1: [redacted]"],
    // key=value / key: value assignments, incl. ENV_VAR=, JSON "key": and
    // header forms like X-Api-Key: value. The value may be quoted.
    [
      /((?:^|[\s"'`;,({])[\w.-]{0,64}?(?:api[_-]?key|secret|token|password|passwd|pwd)[\w.-]{0,64}["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"'`;,}]+)/gim,
      "$1[redacted]",
    ],
  ];
  for (const [pattern, replacement] of patterns) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Cap every line to MAX_LINE_CHARS before redaction. The redaction regexes
 * are linear-time on bounded lines but can go quadratic on pathological long
 * lines, so this bounds CPU as well as memory.
 *
 * Safe direction: if the secret's KEY is in the kept prefix the value is
 * redacted; if the key itself is cut off, the value is gone too — either way
 * no raw secret survives past this point.
 */
export const MAX_LINE_CHARS = 2000;
export function capLogLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)} …[line truncated]` : line,
    )
    .join("\n");
}

/**
 * Scrub scheme://user:password@host userinfo.
 *
 * - The scheme class is bounded ({0,31}) and trailing prose punctuation
 *   (",", ")", ".", "]", ...) is trimmed with a linear scan instead of a
 *   regex, so pathological inputs (dot-runs after a scheme) cannot make this
 *   quadratic. `https://alice:secret@example.com,` is still scrubbed.
 * - Only the authority (up to the first /, ?, or #) is examined, so an `@`
 *   inside a query string (`?q=foo@bar`) is never mistaken for userinfo.
 * - The part before the last @ must be non-empty and contain no "/" — per
 *   RFC 3986 a raw "/" is invalid in userinfo, so a "/" means a path @
 *   (e.g. /@types/node) rather than credentials.
 * - The trailing part must form a valid authority: the candidate
 *   `scheme://authority` is validated with the URL parser (accepting
 *   Unicode/IDN hosts and bracketed IPv6), used for validation only — the
 *   log line keeps its original text.
 */
function redactUrlUserinfo(text: string): string {
  // Trailing punctuation is trimmed with a linear scan, not a regex: the old
  // /[,.;:!?)\]}>"']+$/ pattern backtracked quadratically on dot-runs.
  const TRAILING_PUNCT = ",.;:!?)]>\"'";
  return text.replace(
    /(?<![a-zA-Z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)(\S+)/g,
    (match: string, scheme: string, rest: string) => {
      let end = rest.length;
      while (end > 0 && TRAILING_PUNCT.includes(rest[end - 1])) end--;
      const trimmed = rest.slice(0, end);
      const suffix = rest.slice(end);
      const authEnd = trimmed.search(/[/?#]/);
      const authority = authEnd === -1 ? trimmed : trimmed.slice(0, authEnd);
      const afterAuthority = authEnd === -1 ? "" : trimmed.slice(authEnd);
      const at = authority.lastIndexOf("@");
      if (at <= 0) return match;
      const userinfo = authority.slice(0, at);
      if (userinfo.includes("/")) return match;
      const host = authority.slice(at + 1);
      // Validate the candidate authority with the URL parser instead of a
      // hand-rolled hostname regex: this accepts Unicode/IDN hosts (punycode
      // internally) and bracketed IPv6 while still rejecting prose with @.
      // The URL object is for validation only — the line is rebuilt from the
      // ORIGINAL text so nothing is rewritten to punycode.
      if (!host) return match;
      try {
        void new URL(`${scheme}${authority}`);
      } catch {
        return match;
      }
      return `${scheme}[redacted-userinfo]@${host}${afterAuthority}${suffix}`;
    },
  );
}

/**
 * Keep the last maxBytes bytes of text. UTF-8 safe: the cut is advanced past
 * a partial multi-byte sequence so no replacement character (�) is emitted.
 */
export function truncateToTail(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const encoded = Buffer.byteLength(text, "utf8");
  if (encoded <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text, "utf8");
  let start = buf.length - maxBytes;
  // Advance past UTF-8 continuation bytes (0x80-0xBF); at most 3 steps, the
  // longest possible partial sequence (start of a 4-byte char).
  let steps = 0;
  while (steps < 3 && start < buf.length) {
    const byte: number | undefined = buf[start];
    if (byte === undefined || byte < 0x80 || byte > 0xbf) break;
    start += 1;
    steps += 1;
  }
  return { text: buf.subarray(start).toString("utf8"), truncated: true };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Transport policy for the CasaOS API URL. Only http: and https: are
 * accepted. Plain http: is allowed only for loopback hosts (or with the
 * explicit CASAOS_ALLOW_INSECURE_HTTP=true opt-out, trusted LAN only — the
 * password and the JWT then travel in cleartext). Redirects are never
 * followed (see the `redirect: "error"` on every fetch below), so validating
 * the configured URL is sufficient.
 */
export function assertCasaOSUrlAllowed(baseUrl: string, allowInsecureHttp: boolean): void {
  // M1: fail closed on an unset URL rather than falling back to a default
  // address. The message names the variable because this is a configuration
  // error, not a CasaOS outage.
  if (!baseUrl.trim())
    throw new AppError(
      "CASAOS_API_URL is not set. Point it at your CasaOS address (for example https://casaos.local:1443) and restart OpenMuse.",
      503,
    );
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    // No echo of baseUrl: a malformed value could itself contain a secret.
    throw new AppError("CASAOS_API_URL is not a valid URL.", 503);
  }
  // Reject embedded credentials: Node's fetch refuses to construct a
  // Request from a URL with userinfo, and echoing baseUrl into an error
  // message would disclose the secret in API responses.
  if (url.username || url.password)
    throw new AppError("CASAOS_API_URL must not contain embedded credentials.", 503);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new AppError("CASAOS_API_URL must use http: or https:.", 503);
  // Node's WHATWG URL keeps brackets on IPv6 hostnames ("[::1]"); strip them
  // before the loopback comparison, otherwise http://[::1] is wrongly rejected.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (url.protocol === "http:" && !allowInsecureHttp && !LOOPBACK_HOSTS.has(host))
    throw new AppError(
      `CASAOS_API_URL uses plain HTTP to a non-loopback host (${url.hostname}): the CasaOS password and API token would travel unencrypted. Use an https: address, a loopback address (localhost, 127.0.0.1, ::1), or set CASAOS_ALLOW_INSECURE_HTTP=true if this LAN is trusted.`,
      503,
    );
}

/**
 * Read a JSON response body with a byte cap. Applies a Content-Length
 * pre-check, a streaming cap, and a post-read byte check on the no-body
 * path. This assumes a standards-compliant Response: one that lies about
 * Content-Length could still materialize up to the post-read check.
 */
export async function readBoundedJson(response: Response, capBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > capBytes)
      throw new AppError("CasaOS returned an oversized response.", 502);
  }
  let text: string;
  if (!response.body) {
    // No stream (non-standard Response): never read blindly. The
    // Content-Length check above already rejected declared lengths over the
    // cap, so only read when the header proves the body fits.
    const declared = response.headers.get("content-length");
    const length = declared === null ? Number.NaN : Number(declared);
    if (!Number.isFinite(length) || length > capBytes)
      throw new AppError("CasaOS returned an oversized response.", 502);
    text = await response.text();
    if (Buffer.byteLength(text, "utf8") > capBytes)
      throw new AppError("CasaOS returned an oversized response.", 502);
  } else {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > capBytes) {
        await reader.cancel();
        throw new AppError("CasaOS returned an oversized response.", 502);
      }
      chunks.push(value);
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("CasaOS returned an unreadable response.", 502);
  }
}

/**
 * One live login against /v1/users/login. Used by the credential-save flow.
 * Throws 409 when CasaOS rejects the credentials (deliberately not 401, so it
 * cannot look like our session expired), 502/503 on transport problems.
 * The password is never included in any error message.
 */
export async function verifyCasaOSLogin(
  baseUrl: string,
  username: string,
  password: string,
  allowInsecureHttp = false,
): Promise<string> {
  assertCasaOSUrlAllowed(baseUrl, allowInsecureHttp);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/users/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      // Never follow redirects: a 307/308 to another host would re-POST the
      // credentials there. Redirects surface as a 502 here instead.
      redirect: "error",
    });
  } catch {
    // No baseUrl echo: the configured URL is never known-safe to repeat.
    throw new AppError("CasaOS did not respond to login. Is the server reachable?", 502);
  }
  if (response.status === 401)
    // 409, not 401: this is CasaOS rejecting the credentials, not our session.
    throw new AppError("CasaOS rejected the username or password.", 409);
  if (!response.ok) throw new AppError(`CasaOS login failed (HTTP ${response.status}).`, 502);
  const payload = await readBoundedJson(response, LOGIN_BODY_CAP_BYTES);
  const token = (payload as { data?: { token?: { access_token?: unknown } } })?.data?.token
    ?.access_token;
  if (typeof token !== "string" || !token)
    throw new AppError("CasaOS login did not return an access token.", 502);
  return token;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

/**
 * Transport failures that prove the request never reached CasaOS: the TCP
 * connection could not even be established. Any other transport failure
 * (timeout, reset mid-flight, ...) may have been applied server-side, so for
 * mutating calls it is ambiguous, not a definite failure.
 */
const DEFINITELY_NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);

function transportCauseCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Classify a failed PUT: definite failure only for the 4 codes above. */
function putTransportError(app: string, action: string, error: unknown): Error {
  const code = transportCauseCode(error);
  if (code !== undefined && DEFINITELY_NOT_SENT.has(code))
    return new AppError("CasaOS did not respond. Is the server reachable?", 502);
  return new OutcomeUnknownError(
    `CasaOS did not confirm the ${action} request for "${app}" in time. The action may or may not have happened: no retries were attempted. Check the app's status on CasaOS before trying again.`,
  );
}

// Per-owner access-token cache. The entry is keyed to a connectionId: any credential
// save generates a new connectionId, invalidating both this cache and pending reviews.
const tokenCache = new Map<string, { token: string; connectionId: string }>();
export function clearCasaOSTokenCache(owner?: string): void {
  if (owner) tokenCache.delete(owner);
  else tokenCache.clear();
}

export interface CasaOSClientOptions {
  baseUrl: string;
  owner: string;
  loadCredentials: () => Promise<CasaOSCredentials | null>;
  /**
   * Explicit opt-out of the HTTPS/loopback transport policy. Only for
   * trusted LANs: the CasaOS password and API token then travel in cleartext.
   */
  allowInsecureHttp?: boolean;
}

export class CasaOSClient {
  constructor(private readonly options: CasaOSClientOptions) {
    assertCasaOSUrlAllowed(options.baseUrl, options.allowInsecureHttp ?? false);
  }

  private appgridCache: { at: number; apps: CasaOSAppEntry[] } | null = null;

  private async credentials(): Promise<CasaOSCredentials> {
    const creds = await this.options.loadCredentials();
    if (!creds) throw notConnectedError();
    return creds;
  }

  private async accessToken(creds: CasaOSCredentials): Promise<string> {
    const cached = tokenCache.get(this.options.owner);
    if (cached && cached.connectionId === creds.connectionId) return cached.token;
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/v1/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: creds.username, password: creds.password }),
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
        // Never follow redirects with credentials (see verifyCasaOSLogin).
        redirect: "error",
      });
    } catch {
      throw new AppError("CasaOS did not respond. Is the server reachable?", 502);
    }
    if (response.status === 401)
      // 409, not 401: CasaOS rejected the saved credentials, our session is fine.
      throw new AppError(
        "CasaOS rejected the saved credentials. Reconnect CasaOS in the OpenMuse UI (Connections → CasaOS).",
        409,
      );
    if (!response.ok) throw new AppError(`CasaOS login failed (HTTP ${response.status}).`, 502);
    const payload = await readBoundedJson(response, LOGIN_BODY_CAP_BYTES);
    const token = (payload as { data?: { token?: { access_token?: unknown } } })?.data?.token
      ?.access_token;
    if (typeof token !== "string" || !token)
      throw new AppError("CasaOS login did not return an access token.", 502);
    tokenCache.set(this.options.owner, { token, connectionId: creds.connectionId });
    return token;
  }

  /**
   * Raw request with 401 -> re-login once -> retry once.
   * Returns the parsed JSON payload. For PUT callers, ambiguity is mapped
   * to OutcomeUnknownError by the caller.
   */
  private async requestJson(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const creds = await this.credentials();
    const send = async (token: string): Promise<Response> =>
      fetch(`${this.options.baseUrl}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), Authorization: token },
        signal: AbortSignal.timeout(timeoutMs),
        // Placed after ...init so callers cannot weaken it: redirects are
        // never followed, the JWT stays on the configured host.
        redirect: "error",
      });
    let token = await this.accessToken(creds);
    let response: Response;
    try {
      response = await send(token);
    } catch (error) {
      if (isTimeoutError(error)) throw error; // callers decide: retry vs outcome_unknown
      throw new AppError("CasaOS did not respond. Is the server reachable?", 502);
    }
    if (response.status === 401) {
      // Token expired: re-login once and retry once.
      tokenCache.delete(this.options.owner);
      token = await this.accessToken(creds);
      try {
        response = await send(token);
      } catch (error) {
        if (isTimeoutError(error)) throw error;
        throw new AppError("CasaOS did not respond. Is the server reachable?", 502);
      }
      if (response.status === 401)
        // 409, not 401: CasaOS rejected the saved credentials, our session is fine.
        throw new AppError(
          "CasaOS rejected the saved credentials. Reconnect CasaOS in the OpenMuse UI (Connections → CasaOS).",
          409,
        );
    }
    if (!response.ok)
      throw new AppError(
        `CasaOS request failed (HTTP ${response.status}).`,
        statusCodeOr502(response.status),
      );
    return readBoundedJson(response, JSON_BODY_CAP_BYTES);
  }

  private async getData(path: string, timeoutMs = READ_TIMEOUT_MS): Promise<unknown> {
    let payload: unknown;
    try {
      payload = (await this.requestJson(path, { method: "GET" }, timeoutMs)) as {
        data?: unknown;
      };
    } catch (error) {
      // requestJson rethrows timeouts as-is (PUT callers need the raw signal);
      // read-only callers translate them into a clean 502 instead of leaking
      // a raw DOMException ("The operation was aborted due to timeout").
      if (isTimeoutError(error)) throw new AppError("CasaOS took too long to respond.", 502);
      throw error;
    }
    // v2 endpoints have no `success` field: judge by HTTP status + presence of `data`.
    if (payload === null || typeof payload !== "object" || !("data" in payload))
      throw new AppError("CasaOS returned an unexpected response (missing data).", 502);
    return payload.data;
  }

  /**
   * Validate the app name and confirm it is installed. Returns the URL-encoded name.
   * Throws 404 for bad or unknown names; the raw input is never echoed back.
   */
  async validateApp(app: string): Promise<string> {
    if (!APP_NAME_PATTERN.test(app)) throw new AppError("Unknown CasaOS app.", 404);
    const apps = await this.listApps();
    const match = apps.find((entry) => entry.name === app);
    if (!match) throw new AppError("CasaOS app is not installed.", 404);
    return encodeURIComponent(app);
  }

  /**
   * appgrid projection: only the fields the UI/agent need.
   * Results are cached for a few seconds per client instance so a single
   * logical operation (e.g. getApp -> listApps + validateApp -> listApps)
   * does not fetch twice. Pass refresh=true to bypass (post-PUT polling).
   */
  async listApps(refresh = false): Promise<CasaOSAppEntry[]> {
    const cached = this.appgridCache;
    if (!refresh && cached && Date.now() - cached.at < APPGRID_CACHE_TTL_MS) return cached.apps;
    const data = await this.getData("/v2/app_management/web/appgrid");
    if (!Array.isArray(data)) throw new AppError("CasaOS returned an unexpected app list.", 502);
    const apps = data
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => ({
        name: String(entry.name ?? ""),
        ...(entry.port !== undefined ? { port: String(entry.port) } : {}),
        status: String(entry.status ?? "unknown"),
      }))
      .filter((entry) => entry.name.length > 0);
    this.appgridCache = { at: Date.now(), apps };
    return apps;
  }

  /** App entry plus the allowlisted compose service projection (no environment/secrets). */
  async getApp(app: string): Promise<CasaOSAppDetail> {
    const apps = await this.listApps();
    const entry = apps.find((candidate) => candidate.name === app);
    if (!entry) throw new AppError("CasaOS app is not installed.", 404);
    const services = await this.appServices(app);
    return { ...entry, services };
  }

  /** compose projection: service/image/container_name only — environment is never forwarded. */
  async appServices(app: string): Promise<CasaOSServiceInfo[]> {
    const encoded = await this.validateApp(app);
    const data = await this.getData(`/v2/app_management/compose/${encoded}`);
    const services = (data as { compose?: { services?: unknown } })?.compose?.services;
    if (!services || typeof services !== "object")
      throw new AppError("CasaOS returned an unexpected compose response.", 502);
    return Object.entries(services as Record<string, Record<string, unknown>>)
      .filter(([, service]) => !!service && typeof service === "object")
      .map(([name, service]) => ({
        service: name,
        ...(typeof service.image === "string" ? { image: service.image } : {}),
        ...(typeof service.container_name === "string"
          ? { container_name: service.container_name }
          : {}),
      }));
  }

  /**
   * Log text with a bounded read, secret redaction, and an 8KB tail.
   * Asks the server to cut via `?lines=` first (best-effort); the body is
   * still read with a hard cap, and only the LAST 1MB of log text is kept —
   * the tail is what matters, never the head.
   * `tailLines` is applied client-side after truncation.
   */
  async appLogs(app: string, tailLines?: number): Promise<CasaOSAppLogs> {
    const encoded = await this.validateApp(app);
    const creds = await this.credentials();
    let token: string;
    const cached = tokenCache.get(this.options.owner);
    if (cached && cached.connectionId === creds.connectionId) token = cached.token;
    else token = await this.accessToken(creds);
    const wantLines = typeof tailLines === "number" && tailLines > 0 ? tailLines : 500;
    const fetchLogs = async (auth: string): Promise<Response> =>
      fetch(
        `${this.options.baseUrl}/v2/app_management/compose/${encoded}/logs?lines=${wantLines}`,
        {
          headers: { Authorization: auth },
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
          // Never follow redirects; the JWT must stay on the configured host.
          redirect: "error",
        },
      );
    let response: Response;
    try {
      response = await fetchLogs(token);
    } catch (error) {
      if (isTimeoutError(error))
        throw new AppError("CasaOS took too long to return the logs.", 502);
      throw new AppError("CasaOS did not respond. Is the server reachable?", 502);
    }
    if (response.status === 401) {
      tokenCache.delete(this.options.owner);
      token = await this.accessToken(creds);
      try {
        response = await fetchLogs(token);
      } catch (error) {
        if (isTimeoutError(error))
          throw new AppError("CasaOS took too long to return the logs.", 502);
        throw new AppError("CasaOS did not respond. Is the server reachable?", 502);
      }
    }
    if (!response.ok)
      throw new AppError(
        `CasaOS request failed (HTTP ${response.status}).`,
        statusCodeOr502(response.status),
      );
    const payload = await readBoundedJson(response, LOG_BODY_CAP_BYTES);
    const data = (payload as { data?: unknown })?.data;
    if (typeof data !== "string")
      throw new AppError("CasaOS returned an unexpected log response.", 502);
    // Redact BEFORE truncating: a tail cut could otherwise drop the
    // `password=` key while keeping the secret value, which the redactor
    // could then no longer recognize. Lines are capped BEFORE redaction as
    // well: the redaction patterns are linear-time on bounded lines but can
    // go quadratic on pathological long lines, so capLogLines bounds CPU in
    // addition to memory (the 2MB body cap alone only bounds memory).
    const rawOverTailCap = Buffer.byteLength(data, "utf8") > LOG_READ_CAP_BYTES;
    const redacted = redactCasaOSLogs(capLogLines(data));
    // Keep the LAST 1MB of redacted log text (UTF-8 safe): recent lines, not the head.
    const { text: capped, truncated: cappedTruncated } = truncateToTail(
      redacted,
      LOG_READ_CAP_BYTES,
    );
    const { text, truncated } = truncateToTail(capped, LOG_TAIL_BYTES);
    const lines = text.split("\n");
    const tail = typeof tailLines === "number" && tailLines > 0 ? lines.slice(-tailLines) : lines;
    return {
      lines: tail,
      truncated: rawOverTailCap || cappedTruncated || truncated,
      redacted: true,
    };
  }

  /**
   * PUT raw JSON string "start"|"stop"|"restart". The change is async.
   * Ambiguity (timeout or 5xx) maps to OutcomeUnknownError: no retries, no
   * silent success — the caller reports the ambiguity instead.
   */
  async setAppStatus(app: string, action: "start" | "stop" | "restart"): Promise<void> {
    // The union type is compile-time only: validate at runtime too, since the
    // request body is built directly from this value.
    if (!["start", "stop", "restart"].includes(action))
      throw new AppError("Invalid CasaOS action.", 400);
    const encoded = await this.validateApp(app);
    const creds = await this.credentials();
    const send = async (token: string): Promise<Response> =>
      fetch(`${this.options.baseUrl}/v2/app_management/compose/${encoded}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: token },
        // The API requires a raw JSON string body, not an object.
        body: JSON.stringify(action),
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
        // A redirect here throws; putTransportError maps it to
        // outcome_unknown (conservative: the first request may have applied).
        redirect: "error",
      });
    let response: Response | undefined;
    let token = await this.accessToken(creds);
    try {
      response = await send(token);
    } catch (error) {
      throw putTransportError(app, action, error);
    }
    if (response.status === 401) {
      tokenCache.delete(this.options.owner);
      token = await this.accessToken(creds);
      try {
        response = await send(token);
      } catch (error) {
        throw putTransportError(app, action, error);
      }
    }
    if (response.status >= 500)
      throw new OutcomeUnknownError(
        `CasaOS returned HTTP ${response.status} for the ${action} request on "${app}". The action may or may not have happened: no retries were attempted. Check the app's status on CasaOS before trying again.`,
      );
    if (!response.ok)
      throw new AppError(
        `CasaOS rejected the ${action} request for "${app}" (HTTP ${response.status}).`,
        statusCodeOr502(response.status),
      );
  }

  async systemUtilization(): Promise<CasaOSSystemStatus> {
    const data = (await this.getData("/v1/sys/utilization")) as {
      cpu?: { percent?: unknown; temperature?: unknown };
      mem?: { usedPercent?: unknown };
      net?: unknown;
    };
    const num = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;
    // Live-verified 2026-10-01 (CasaOS 0.4.9): net is an ARRAY of interface
    // objects with cumulative counters {name, bytesSent, bytesRecv, ...}.
    // Prefer bytesSent/bytesRecv when present; fall back to up/down keys;
    // tolerate the object shape as well.
    const netOf = (direction: "up" | "down"): number | undefined => {
      const liveKey = direction === "up" ? "bytesSent" : "bytesRecv";
      const net = data?.net;
      if (Array.isArray(net)) {
        let total = 0;
        let seen = false;
        for (const entry of net) {
          if (!entry || typeof entry !== "object") continue;
          const rec = entry as Record<string, unknown>;
          const v = num(rec[liveKey]) ?? num(rec[direction]);
          if (v !== undefined) {
            total += v;
            seen = true;
          }
        }
        return seen ? total : undefined;
      }
      if (net && typeof net === "object") {
        const rec = net as Record<string, unknown>;
        return num(rec[liveKey]) ?? num(rec[direction]);
      }
      return undefined;
    };
    return {
      cpu_percent: num(data?.cpu?.percent),
      cpu_temperature_c: num(data?.cpu?.temperature),
      memory_used_percent: num(data?.mem?.usedPercent),
      network_up_bytes: netOf("up"),
      network_down_bytes: netOf("down"),
    };
  }
}

/**
 * Map a CasaOS upstream status to one of our API statuses. CasaOS 401/403/404
 * are never passed through as our own: a CasaOS 401 must not look like our
 * session expired (409 instead), and CasaOS 403/404 carry no meaning for our
 * callers (502 instead).
 */
function statusCodeOr502(status: number): 400 | 409 | 413 | 422 | 429 | 500 | 502 | 503 {
  if (status === 401) return 409;
  if (status === 403 || status === 404) return 502;
  return [400, 409, 413, 422, 429, 500, 502, 503].includes(status)
    ? (status as 400 | 409 | 413 | 422 | 429 | 500 | 502 | 503)
    : 502;
}
