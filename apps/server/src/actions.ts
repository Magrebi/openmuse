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
    // Generation-scoped idempotency. A terminal but non-replayable record
    // (denied/expired/cancelled/failed) must not shadow later reviews: each such
    // record advances the lookup to the next generation, so a repeated propose()
    // finds the pending or replayable review instead of minting another
    // duplicate. Generation 0 keeps the historical sha256(key) ID, so existing
    // records are unaffected.
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
  /**
   * Rewrite a proposal that is still waiting for review.
   *
   * Editing inside the approval card is the obvious thing to want: the agent
   * drafted something nearly right and the fix is a word, not a new round trip
   * through a separate editor that throws the proposal away.
   *
   * The constraint that shapes this is the hash. It exists so that an approval
   * can only ever apply to the exact bytes the reviewer saw, and it is checked
   * at decide time. If an amendment could change the payload while leaving the
   * hash alone, that guarantee would quietly become false — a reviewer approves
   * what was displayed and something else is sent. So an amendment recomputes
   * the hash over the new input, which means the client must approve again with
   * the hash it gets back. That is the point: the edit is a new thing to review,
   * and it gets reviewed as one.
   *
   * The write is a compare-and-swap on the status, hash and expiry together.
   * Checking them with a read and then writing would leave a window in which an
   * approval that arrived mid-amendment could execute the old payload while the
   * stored row claimed the new one.
   */
  async amend(
    owner: string,
    id: string,
    hash: string,
    patch: Record<string, unknown>,
  ): Promise<ActionProposal> {
    const proposal = await this.db.get<ActionProposal>(owner, "actions", id);
    if (!proposal) throw new AppError("Action not found", 404);
    if (proposal.hash !== hash)
      throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
    if (proposal.status !== "awaiting_review")
      throw new AppError("This action is no longer open for review.", 409);
    if (Date.parse(proposal.expiresAt) <= this.now())
      throw new AppError("This review expired. Create a fresh proposal.", 409);

    // `kind` selects the schema, the executor and the target version, so it must
    // not be reachable through the patch. The schema would strip it anyway, but
    // only because these objects happen to be strict; refusing it outright means
    // the invariant does not rest on that.
    if ("kind" in patch)
      throw new AppError("An action's kind cannot be changed during review.", 409);
    const input = proposalSchema.parse({
      kind: proposal.kind,
      data: { ...proposal.data, ...patch },
    });
    const connection = await this.options.connection?.(owner, proposal.kind);
    if (this.options.connection && !connection)
      throw new AppError(
        proposal.kind === "casaos.action"
          ? "Connect CasaOS before preparing an action"
          : "Connect Google before preparing an action",
        409,
      );
    if (
      connection &&
      (connection.id !== proposal.connectionId || connection.account !== proposal.account)
    )
      throw new AppError(
        proposal.kind === "casaos.action"
          ? "CasaOS connection changed. Prepare a new action."
          : "Google account or connection changed. Prepare a new action for the connected account.",
        409,
      );
    // Re-prepared rather than reused: a calendar update's target version is the
    // event's own version, and it must describe the event as it is now, not as
    // it was when the agent first drafted this.
    const prepared = await this.options.prepare?.(owner, input, connection?.id);
    const final = proposalSchema.parse(prepared?.input ?? input);
    const nextHash = createHash("sha256")
      .update(
        JSON.stringify({
          input: final,
          connection,
          target: prepared?.target,
          targetVersion: prepared?.targetVersion,
        }),
      )
      .digest("hex");
    const amended = await this.db.compareAndSwap<ActionProposal>(
      owner,
      "actions",
      id,
      { status: "awaiting_review", hash, expiresAt: proposal.expiresAt },
      {
        data: final.data,
        target: prepared?.target ?? proposal.target,
        targetVersion: prepared?.targetVersion ?? proposal.targetVersion,
        hash: nextHash,
      },
    );
    if (!amended) {
      // Someone decided while this amendment was being prepared.
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      throw new AppError("This action was decided while it was being edited.", 409);
    }
    await this.record(owner, amended, "Edited during review; review the updated details");
    return amended;
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
      hash,
    );
    if (!claimed) {
      const current = await this.db.get<ActionProposal>(owner, "actions", id);
      if (!current) throw new AppError("Action not found", 404);
      if (current.hash !== hash)
        throw new AppError("This proposal changed. Open its latest review before deciding.", 409);
      // Losing the claim normally means a concurrent decision already moved this
      // action on, and `current` is then that newer record. A record still waiting
      // for review means the claim never matched the stored row at all, and
      // returning it would report a decision as accepted that never happened.
      if (current.status === "awaiting_review")
        throw new AppError("This review could not be claimed. Create a fresh proposal.", 409);
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
