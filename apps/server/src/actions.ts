import { createHash, randomUUID } from "node:crypto";
import {
  type ActionProposal,
  type CalendarEvent,
  type ProposalInput,
  proposalSchema,
} from "../../../packages/domain/src/index.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

interface Options {
  execute: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
    targetVersion?: string,
  ) => Promise<string>;
  prepare?: (
    owner: string,
    input: ProposalInput,
    connectionId?: string,
  ) => Promise<{
    input: ProposalInput;
    target?: CalendarEvent;
    targetVersion?: string;
  }>;
  connected: (owner: string, kind?: ProposalInput["kind"]) => Promise<boolean>;
  connection?: (
    owner: string,
    kind?: ProposalInput["kind"],
  ) => Promise<{ id: string; account: string } | null>;
  now?: () => number;
}
export class ActionService {
  private readonly now: () => number;
  constructor(
    private readonly db: Store,
    private readonly options: Options,
  ) {
    this.now = options.now ?? Date.now;
  }
  async propose(
    owner: string,
    raw: unknown,
    idempotencyKey?: string,
    taskId?: string,
  ): Promise<ActionProposal> {
    // Terminal CasaOS records are replayed only when it is safe: a resumed
    // task re-proposing an action that already SUCCEEDED (or whose outcome is
    // UNKNOWN and must not be re-executed) gets the recorded result back
    // instead of a second review — otherwise every re-run would open an
    // approval loop. Denied/expired/cancelled/failed records always produce a
    // fresh review, so a denial can never be replayed as an approval.
    const TERMINAL_CASAOS_STATUSES = new Set([
      "succeeded",
      "failed",
      "outcome_unknown",
      "denied",
      "cancelled",
      "expired",
    ]);
    // Statuses safe to replay for the same task: re-executing could
    // double-apply (or already applied), so the recorded result stands.
    const REPLAYABLE_CASAOS_STATUSES = new Set(["succeeded", "outcome_unknown"]);
    // Fix round 11: generation-scoped idempotency. A terminal but
    // non-replayable record (denied/expired/cancelled/failed) must not shadow
    // later reviews: each such record advances the lookup to the next
    // generation, so a repeated propose() finds the pending or replayable
    // review instead of minting another duplicate. Generation 0 keeps the
    // historical sha256(key) ID, so existing records are unaffected.
    const MAX_ACTION_GENERATIONS = 50;
    const idForGeneration = (key: string, generation: number): string =>
      createHash("sha256")
        .update(generation === 0 ? key : `${key}#${generation}`)
        .digest("hex");
    let id: string;
    if (idempotencyKey === undefined) {
      id = randomUUID();
    } else {
      let chosen: string | undefined;
      for (let generation = 0; generation < MAX_ACTION_GENERATIONS; generation += 1) {
        const candidate = idForGeneration(idempotencyKey, generation);
        const existing = await this.db.get<ActionProposal>(owner, "actions", candidate);
        if (!existing) {
          chosen = candidate; // empty slot: create the proposal here
          break;
        }
        if (existing.kind === "casaos.action" && TERMINAL_CASAOS_STATUSES.has(existing.status)) {
          if (
            existing.taskId !== undefined &&
            existing.taskId === taskId &&
            REPLAYABLE_CASAOS_STATUSES.has(existing.status)
          ) {
            // Replay: return a copy flagged as replayed (transient, not
            // persisted) so the tool handler can annotate the result and the
            // model cannot present the re-skipped action as freshly executed.
            return { ...existing, replayed: true };
          }
          continue; // terminal but not replayable: try the next generation
        }
        // A pending/executing CasaOS review, or any non-CasaOS record, keeps
        // today's behavior: return the existing review as-is.
        return existing;
      }
      // Generation space exhausted (not expected in practice): fall back to a
      // fresh random ID rather than overwriting an existing record.
      id = chosen ?? randomUUID();
    }
    const parsed = proposalSchema.parse(raw);
    const connection = await this.options.connection?.(owner, parsed.kind);
    if (this.options.connection && !connection)
      throw new AppError(
        parsed.kind === "casaos.action"
          ? "Connect CasaOS before preparing an action"
          : "Connect Google before preparing an action",
        409,
      );
    const prepared = await this.options.prepare?.(owner, parsed, connection?.id);
    const input = proposalSchema.parse(prepared?.input ?? parsed);
    const title =
      input.kind === "casaos.action"
        ? `${{ start: "Start", stop: "Stop", restart: "Restart" }[input.data.action]} ${input.data.app} on CasaOS`
        : input.kind === "email.send"
          ? `Send “${input.data.subject}”`
          : input.kind === "calendar.delete"
            ? `Delete ${input.data.title}`
            : `${input.kind === "calendar.create" ? "Create" : "Update"} ${input.data.title}`;
    const createdAt = new Date(this.now()).toISOString();
    const proposal: ActionProposal = {
      id,
      taskId,
      title,
      kind: input.kind,
      data: input.data,
      account: connection?.account,
      connectionId: connection?.id,
      target: prepared?.target,
      targetVersion: prepared?.targetVersion,
      status: "awaiting_review",
      hash: createHash("sha256")
        .update(
          JSON.stringify({
            input,
            connection,
            target: prepared?.target,
            targetVersion: prepared?.targetVersion,
          }),
        )
        .digest("hex"),
      createdAt,
      expiresAt: new Date(this.now() + 30 * 60 * 1000).toISOString(),
    };
    const saved =
      idempotencyKey === undefined
        ? await this.db.put(owner, "actions", proposal)
        : await this.db.insertIfAbsent(owner, "actions", proposal);
    if (!saved) {
      const existing = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!existing) throw new AppError("Prepared action could not be loaded", 409);
      return existing;
    }
    await this.record(owner, saved, "Ready for your review");
    return saved;
  }
  async decide(
    owner: string,
    id: string,
    hash: string,
    decision: "approve" | "deny",
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review") return proposal;
    if (decision === "approve" && proposal.taskId) {
      const task = await this.db.get<{ status: string }>(owner, "tasks", proposal.taskId);
      if (!task || !["running", "waiting_approval"].includes(task.status))
        throw new AppError(
          "Resume the task before approving this action. Cancelled tasks cannot execute.",
          409,
        );
    }
    if (Date.parse(proposal.expiresAt) <= this.now()) {
      const expired = await this.db.compareAndSwap<ActionProposal>(
        owner,
        "actions",
        id,
        { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
        { status: "expired" },
      );
      if (!expired) {
        const current = await this.db.get<ActionProposal>(owner, "actions", id);
        if (!current) throw new AppError("Action not found", 404);
        return current;
      }
      throw new AppError("This review expired. Create a fresh proposal.", 409);
    }
    if (decision === "approve" && !(await this.options.connected(owner, proposal.kind)))
      throw new AppError(
        proposal.kind === "casaos.action"
          ? "CasaOS is disconnected. Reconnect before approving this action."
          : "Google is disconnected. Reconnect before approving this action.",
        409,
      );
    if (decision === "approve" && this.options.connection) {
      const connection = await this.options.connection(owner, proposal.kind);
      if (
        !connection ||
        connection.id !== proposal.connectionId ||
        connection.account !== proposal.account
      )
        throw new AppError(
          proposal.kind === "casaos.action"
            ? "CasaOS connection changed. Prepare a new action."
            : "Google account or connection changed. Prepare a new action for the connected account.",
          409,
        );
    }
    const claimed = await this.db.claim<ActionProposal>(
      owner,
      id,
      decision === "deny" ? "denied" : "executing",
      new Date(this.now()).toISOString(),
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      return current;
    }
    await this.record(
      owner,
      claimed,
      decision === "deny" ? "Declined; no changes made" : "Approved; execution started",
    );
    if (decision === "deny") return claimed;
    let finished: ActionProposal;
    try {
      const input = proposalSchema.parse({ kind: claimed.kind, data: claimed.data });
      const result = await this.options.execute(
        owner,
        input,
        claimed.connectionId,
        claimed.targetVersion,
      );
      finished = { ...claimed, status: "succeeded", result };
    } catch (error) {
      const unknown =
        error instanceof Error &&
        (("outcomeUnknown" in error && error.outcomeUnknown === true) ||
          ("code" in error && error.code === "outcome_unknown"));
      finished = {
        ...claimed,
        status: unknown ? "outcome_unknown" : "failed",
        error: error instanceof Error ? error.message : "Execution failed",
      };
    }
    await this.db.put(owner, "actions", finished);
    await this.record(owner, finished, finished.result ?? finished.error ?? finished.status);
    return finished;
  }
  private async record(owner: string, action: ActionProposal, detail: string) {
    await this.db.put(owner, "activity", {
      id: randomUUID(),
      actionId: action.id,
      title: action.title,
      detail,
      date: new Date(this.now()).toISOString(),
      status: action.status,
    });
  }
}
