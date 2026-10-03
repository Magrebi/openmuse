import { z } from "zod";
import { DesktopError } from "./errors.js";
import type { HealthProbe } from "./state.js";

/** The contract the desktop app reads. Mirrors `GET /api/health` in apps/server. */
export const healthPayloadSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(["sample", "live"]),
  agentConfigured: z.boolean(),
  browserConfigured: z.boolean(),
});

export type HealthPayload = z.infer<typeof healthPayloadSchema>;

export interface HealthReading {
  readonly probe: HealthProbe;
  readonly payload?: HealthPayload;
  /** One line the person can act on. Never a stack trace. */
  readonly fix?: string;
}

/**
 * `healthy` requires every part of the deployment to be configured, so a partly
 * configured stack lands in `degraded` and shows the amber tray without needing
 * a second rule anywhere else.
 */
export function classifyHealth(payload: HealthPayload): HealthProbe {
  if (!payload.ok) return "degraded";
  return payload.agentConfigured && payload.browserConfigured ? "healthy" : "degraded";
}

export function degradedFix(payload: HealthPayload): string | undefined {
  if (payload.agentConfigured && payload.browserConfigured) return undefined;
  if (!payload.agentConfigured)
    return "Set a model provider key in the Setup wizard, or stay in sample mode.";
  return "Set BROWSER_WORKER_URL and WORKER_TOKEN to enable the browser worker.";
}

/**
 * Poll the API once. Unreachable and malformed are distinguished so the UI can
 * say "start Docker" instead of showing a parse error.
 */
export async function readHealth(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2000,
): Promise<HealthReading> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok)
      return { probe: "degraded", fix: `The API answered ${response.status}. Check the API logs.` };
    const parsed = healthPayloadSchema.safeParse(await response.json());
    if (!parsed.success)
      return {
        probe: "degraded",
        fix: "The API answered something unexpected. Check the API logs.",
      };
    return {
      probe: classifyHealth(parsed.data),
      payload: parsed.data,
      fix: degradedFix(parsed.data),
    };
  } catch {
    return {
      probe: "unreachable",
      fix: "OpenMuse is not responding. Start it, then retry.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reject a health URL that is not loopback. The app never leaves the machine. */
export function assertLoopback(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DesktopError("HEALTH_INVALID", `Not a URL: ${url}`);
  }
  if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname))
    throw new DesktopError(
      "HEALTH_INVALID",
      `Refusing to contact ${parsed.hostname}`,
      "The desktop app only talks to OpenMuse on this computer.",
    );
  return parsed;
}
