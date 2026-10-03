/**
 * The control surface. It renders the deployment state machine and writes
 * through the shared core modules — the tray tone, the `.env` diff and the
 * secret handling all come from `../src`, so this page owns no rule of its own
 * and cannot disagree with the tray or the notifications.
 */

import type { ServiceName } from "../src/deployment.js";
import { applyEnvValues, parseEnvFile, planEnvUpdate, summarizePlan } from "../src/envfile.js";
import { cryptoRandomBytes } from "../src/secrets.js";
import { type DeploymentState, toneFor } from "../src/state.js";
import { intelligenceStep, modelStep, secretStatuses, secretsStep } from "../src/wizard.js";

const root = (window as DesktopWindow).__OPENMUSE_ROOT__ ?? "";
const composeFile = "infra/compose.yaml";
const envFile = ".env";
const paths = { root, composeFile, envFile };

interface DesktopWindow extends Window {
  __OPENMUSE_ROOT__?: string;
  __TAURI__?: {
    core: { invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T> };
    event: {
      listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
    };
  };
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const invoke = <T>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
  const bridge = (window as DesktopWindow).__TAURI__?.core?.invoke;
  if (!bridge) throw new Error("The desktop shell is not attached to this page.");
  return bridge<T>(command, args);
};

/** Untrusted text for display only. Never executed or interpreted. */
const logs: Record<ServiceName, string[]> = { api: [], web: [], "browser-worker": [] };
let activeService: ServiceName = "api";
let deployment: DeploymentState = "unknown";
const activeStates = new Set<DeploymentState>(["starting", "healthy", "degraded", "stopping"]);

function renderLog(): void {
  el("log").textContent = logs[activeService].slice(-400).join("\n");
}

function render(): void {
  const pill = el("state");
  pill.textContent = deployment;
  // The tone comes from the core's single derivation, never a local copy.
  pill.dataset.tone = toneFor(deployment);
  el<HTMLButtonElement>("start").disabled = activeStates.has(deployment);
  el<HTMLButtonElement>("stop").disabled = !activeStates.has(deployment) && deployment !== "error";
  renderLog();
}

function setState(next: DeploymentState, reason?: string): void {
  deployment = next;
  const banner = el("reason");
  banner.hidden = !reason;
  if (reason) banner.textContent = reason;
  render();
}

function renderChecks(checks: { label: string; ok: boolean; fix?: string }[]): void {
  const list = el("check-list");
  list.replaceChildren();
  for (const check of checks) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = check.label;
    const status = document.createElement("span");
    status.className = check.ok ? "" : "failed";
    // One line the person can act on, never a stack trace.
    status.textContent = check.ok ? "ready" : (check.fix ?? "not ready");
    item.append(label, status);
    list.append(item);
  }
}

async function refreshChecks(): Promise<void> {
  const checks = await invoke<{ label: string; ok: boolean; fix?: string }[]>("prerequisites", {
    paths,
  });
  renderChecks(checks);
  // The first failing check becomes the one line shown under the state pill.
  const failed = checks.find((check) => !check.ok);
  if (failed && deployment !== "healthy") setState(deployment, failed.fix);
}

async function guard(button: HTMLElement, work: () => Promise<void>): Promise<void> {
  (button as HTMLButtonElement).disabled = true;
  try {
    await work();
  } catch (error) {
    const failure = error as { fix?: string; message?: string };
    setState(deployment, failure.fix ?? failure.message ?? String(error));
  } finally {
    render();
  }
}

async function runCompose(action: "up" | "down"): Promise<void> {
  const args =
    action === "up"
      ? ["compose", "-f", composeFile, "--env-file", envFile, "up", "-d"]
      : // Never `-v`: the volumes hold saved browser profiles and downloads.
        ["compose", "-f", composeFile, "--env-file", envFile, "down"];
  setState(action === "up" ? "starting" : "stopping");
  const result = await invoke<{ exitCode: number | null; timedOut: boolean }>("run_command", {
    paths,
    program: "docker",
    args,
    timeoutMs: 600000,
  });
  setState(
    result.exitCode !== 0 || result.timedOut ? "error" : "stopped",
    result.exitCode !== 0 || result.timedOut
      ? "Could not reach Docker. Start Docker Desktop, then try again."
      : action === "up"
        ? "Stack started."
        : "Stack stopped.",
  );
}

async function saveWizard(): Promise<void> {
  const before = await invoke<string>("read_file", { paths, relative: envFile });
  const provider = el<HTMLSelectElement>("provider").value as "openai" | "anthropic" | "google";
  const model = el<HTMLInputElement>("model").value.trim();
  const providerKey = el<HTMLInputElement>("provider-key").value.trim();
  const intelligence = el<HTMLInputElement>("intelligence").value.trim();

  // Generated secrets merge in only where .env has none, so a re-run repairs a
  // broken file instead of rotating a working deployment's key.
  const step = secretsStep(before, cryptoRandomBytes);
  const updates = {
    ...step.updates,
    ...modelStep(before, { provider, model, apiKey: providerKey }).updates,
    ...intelligenceStep(before, intelligence),
  };

  // The diff is shown before it is applied, with every secret value hidden.
  const plan = planEnvUpdate(before, updates);
  if (!globalThis.confirm(`Write these changes to .env?\n\n${summarizePlan(plan)}`)) return;
  await invoke("write_file", {
    paths,
    relative: envFile,
    contents: applyEnvValues(before, updates),
  });

  const banner = el("generated");
  banner.hidden = !step.generated?.OPENMUSE_ACCESS_KEY;
  // Shown once so it can be copied; it lives in .env, which the owner already has.
  if (step.generated?.OPENMUSE_ACCESS_KEY)
    banner.textContent = `Access key: ${step.generated.OPENMUSE_ACCESS_KEY}`;
  el<HTMLInputElement>("provider-key").value = "";
  el<HTMLInputElement>("intelligence").value = "";
  el("wizard").hidden = true;
}

async function main(): Promise<void> {
  render();
  // The prerequisites are the launch check: Docker, the compose plugin, the
  // three ports, and whether `.env` exists at all.
  await refreshChecks().catch(() => undefined);
  el("start").addEventListener("click", (event) =>
    guard(event.currentTarget as HTMLElement, async () => {
      await refreshChecks();
      await runCompose("up");
    }),
  );
  el("stop").addEventListener("click", (event) =>
    guard(event.currentTarget as HTMLElement, () => runCompose("down")),
  );
  el("open").addEventListener("click", (event) =>
    // Loopback only; the native host refuses anything else.
    guard(event.currentTarget as HTMLElement, async () => {
      await invoke("open_web_ui", { url: "http://127.0.0.1:8081/" });
    }),
  );
  el("setup").addEventListener("click", () => {
    el("wizard").hidden = !el("wizard").hidden;
  });
  el("cancel").addEventListener("click", () => {
    el("wizard").hidden = true;
  });
  el("save").addEventListener("click", (event) =>
    guard(event.currentTarget as HTMLElement, saveWizard),
  );

  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs button")) {
    tab.addEventListener("click", () => {
      for (const other of document.querySelectorAll<HTMLButtonElement>(".tabs button"))
        other.setAttribute("aria-selected", String(other === tab));
      activeService = (tab.dataset.service ?? "api") as ServiceName;
      renderLog();
    });
  }

  const listen = (window as DesktopWindow).__TAURI__?.event?.listen;
  if (listen)
    await listen("openmuse://log", (event) => {
      const payload = event.payload as { service: ServiceName; line: string };
      // Output arrives already redacted, and is only ever displayed.
      logs[payload.service].push(payload.line);
      renderLog();
    });

  // Report the first missing secret without printing any of them.
  const before = await invoke<string>("read_file", { paths, relative: envFile });
  const missing = secretStatuses(parseEnvFile(before)).filter(
    (entry) => entry.status !== "present",
  );
  if (missing.length) setState("unknown", missing[0]?.fix);
}

void main();
