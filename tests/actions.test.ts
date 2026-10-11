import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { z } from "zod";
import { ActionService } from "../apps/server/src/actions.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { type ActionProposal, eventDraftSchema } from "../packages/domain/src/index.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

let db: Store;
before(async () => {
  db = await createStore();
});
after(async () => {
  await db.close();
});
const email = {
  kind: "email.send" as const,
  data: {
    to: ["sam@example.com"],
    subject: "Visit",
    body: "See attached.",
    cc: [],
    bcc: [],
    attachmentIds: [],
  },
};
test("denying a persisted proposal never calls its adapter", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("deny-user", email);
  assert.equal(proposal.status, "awaiting_review");
  const result = await service.decide("deny-user", proposal.id, proposal.hash, "deny");
  assert.equal(result.status, "denied");
  assert.equal(calls, 0);
});
test("concurrent approval consumes the proposal only once", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "provider-receipt";
    },
    connected: async () => true,
  });
  const proposal = await service.propose("once-user", email);
  await Promise.allSettled([
    service.decide("once-user", proposal.id, proposal.hash, "approve"),
    service.decide("once-user", proposal.id, proposal.hash, "approve"),
  ]);
  assert.equal(calls, 1);
  const saved = await db.get("once-user", "actions", proposal.id);
  assert.equal(saved?.status, "succeeded");
  assert.equal(saved?.result, "provider-receipt");
});
test("wrong owner and stale hash cannot approve", async () => {
  const service = new ActionService(db, {
    execute: async () => "sent",
    connected: async () => true,
  });
  const proposal = await service.propose("private-user", email);
  await assert.rejects(
    service.decide("attacker", proposal.id, proposal.hash, "approve"),
    /not found/i,
  );
  await assert.rejects(service.decide("private-user", proposal.id, "stale", "approve"), /changed/i);
});
test("expired and disconnected proposals never reach the provider", async () => {
  let now = Date.now();
  let connected = true;
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => connected,
    now: () => now,
  });
  const expired = await service.propose("expired-user", email);
  now += 31 * 60 * 1000;
  await assert.rejects(
    service.decide("expired-user", expired.id, expired.hash, "approve"),
    /expired/i,
  );
  const revoked = await service.propose("revoked-user", email);
  connected = false;
  await assert.rejects(
    service.decide("revoked-user", revoked.id, revoked.hash, "approve"),
    /disconnected/i,
  );
  assert.equal(calls, 0);
});
test("uncertain writes retain uncertainty and cannot be retried", async () => {
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      throw Object.assign(new Error("Provider response lost"), { outcomeUnknown: true });
    },
    connected: async () => true,
  });
  const proposal = await service.propose("uncertain-user", email);
  const result = await service.decide("uncertain-user", proposal.id, proposal.hash, "approve");
  assert.equal(result.status, "outcome_unknown");
  await service.decide("uncertain-user", proposal.id, proposal.hash, "approve");
  assert.equal(calls, 1);
});
test("another service instance sees persisted proposals", async () => {
  const options = { execute: async () => "created", connected: async () => true };
  const first = new ActionService(db, options);
  const proposal = await first.propose("resume-user", email);
  const second = new ActionService(db, options);
  assert.equal(
    (await second.decide("resume-user", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
});
test("event validation preserves all-day semantics and rejects missing offsets", () => {
  const base = { title: "Visit", start: "2026-10-23", end: "2026-10-24", allDay: true };
  assert.equal(eventDraftSchema.parse(base).start, "2026-10-23");
  assert.equal(eventDraftSchema.safeParse({ ...base, allDay: false }).success, false);
  assert.equal(eventDraftSchema.safeParse({ ...base, end: "2026-10-22" }).success, false);
  assert.equal(eventDraftSchema.safeParse({ ...base, timeZone: "Not/AZone" }).success, false);
});
test("account switching and reconnecting invalidate a prepared action", async () => {
  let connection = { id: "connection-a", account: "a@example.com" };
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => {
      calls++;
      return "sent";
    },
    connected: async () => true,
    connection: async () => connection,
  });
  const proposal = await service.propose("account-user", email);
  assert.equal(proposal.account, "a@example.com");
  connection = { id: "connection-b", account: "b@example.com" };
  await assert.rejects(
    service.decide("account-user", proposal.id, proposal.hash, "approve"),
    /connection changed/i,
  );
  connection = { id: "connection-new-a", account: "a@example.com" };
  await assert.rejects(
    service.decide("account-user", proposal.id, proposal.hash, "approve"),
    /connection changed/i,
  );
  assert.equal(calls, 0);
});

test("review stores authoritative calendar details and binds execution to their version", async () => {
  const target = {
    id: "event-1",
    ...eventDraftSchema.parse({
      title: "Provider title",
      start: "2026-10-23",
      end: "2026-10-24",
      allDay: true,
    }),
  };
  let version = '"revision-1"';
  const service = new ActionService(db, {
    connected: async () => true,
    connection: async () => ({ id: "calendar-connection", account: "me@example.com" }),
    prepare: async (_owner, input, connectionId) => {
      assert.equal(connectionId, "calendar-connection");
      assert.equal(input.kind, "calendar.delete");
      return {
        input: {
          kind: "calendar.delete",
          data: { eventId: target.id, calendarId: "primary", title: target.title },
        },
        target,
        targetVersion: version,
      };
    },
    execute: async (_owner, input, connectionId, targetVersion) => {
      assert.ok(input.kind === "calendar.delete");
      assert.equal(input.data.title, "Provider title");
      assert.equal(connectionId, "calendar-connection");
      assert.equal(targetVersion, '"revision-1"');
      return "Deleted";
    },
  });
  const input = {
    kind: "calendar.delete",
    data: { eventId: target.id, calendarId: "primary", title: "Untrusted title" },
  };
  const proposal = await service.propose("review-owner", input);
  assert.equal(proposal.title, "Delete Provider title");
  assert.deepEqual(proposal.target, target);
  assert.equal(proposal.targetVersion, version);
  version = '"revision-2"';
  const newer = await service.propose("review-owner", input);
  assert.notEqual(newer.hash, proposal.hash);
  assert.equal(
    (await service.decide("review-owner", proposal.id, proposal.hash, "approve")).status,
    "succeeded",
  );
});

test("idempotent proposal replay returns a completed action before another provider preparation", async () => {
  let preparations = 0;
  const service = new ActionService(db, {
    connected: async () => true,
    prepare: async (_owner, input) => {
      preparations++;
      return { input };
    },
    execute: async () => "sent",
  });
  const proposal = await service.propose("replay-owner", email, "run/tool-1");
  await service.decide("replay-owner", proposal.id, proposal.hash, "approve");
  const replay = await service.propose("replay-owner", email, "run/tool-1");
  assert.equal(replay.id, proposal.id);
  assert.equal(replay.status, "succeeded");
  assert.equal(preparations, 1);
  const otherOwner = await service.propose("different-owner", email, "run/tool-1");
  assert.equal(otherOwner.status, "awaiting_review");
});

test("concurrent idempotent proposals retain a single persisted review and activity entry", async () => {
  const service = new ActionService(db, {
    connected: async () => true,
    execute: async () => "sent",
  });
  const results = await Promise.all([
    service.propose("concurrent-replay", email, "run/tool-1"),
    service.propose("concurrent-replay", email, "run/tool-1"),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal((await db.list("concurrent-replay", "actions")).length, 1);
  assert.equal((await db.list("concurrent-replay", "activity")).length, 1);
});

test("an expired stale review cannot overwrite a concurrently executing action", async (t) => {
  let now = Date.now();
  const read = deferred<void>();
  const resumeRead = deferred<void>();
  const executing = deferred<void>();
  const finishExecution = deferred<string>();
  const service = new ActionService(db, {
    connected: async () => true,
    now: () => now,
    execute: async () => {
      executing.resolve();
      return finishExecution.promise;
    },
  });
  const proposal = await service.propose("expiry-race", email);
  const originalGet = db.get.bind(db);
  let intercept = true;
  t.mock.method(db, "get", async (...args: Parameters<Store["get"]>) => {
    const result = await originalGet(...args);
    if (intercept && args[0] === "expiry-race" && args[1] === "actions") {
      intercept = false;
      read.resolve();
      await resumeRead.promise;
    }
    return result;
  });
  const stale = service.decide("expiry-race", proposal.id, proposal.hash, "approve");
  await read.promise;
  const approval = service.decide("expiry-race", proposal.id, proposal.hash, "approve");
  await executing.promise;
  now += 31 * 60 * 1000;
  resumeRead.resolve();
  await stale.catch((error) => assert.match(error.message, /expired/i));
  const saved = await db.get<ActionProposal>("expiry-race", "actions", proposal.id);
  finishExecution.resolve("sent");
  await approval;
  assert.equal(saved?.status, "executing");
});

/** A service that records exactly what it was asked to execute. */
function recorder() {
  const seen: { subject: string; body: string }[] = [];
  const service = new ActionService(db, {
    execute: async (_owner, input) => {
      if (input.kind === "email.send")
        seen.push({ subject: input.data.subject, body: input.data.body });
      return "sent";
    },
    connected: async () => true,
  });
  return { service, seen };
}

test("an amendment changes what is executed", async () => {
  const { service, seen } = recorder();
  const proposal = await service.propose("amend-user", email);
  const amended = await service.amend("amend-user", proposal.id, proposal.hash, {
    subject: "Visit on Saturday",
  });
  assert.equal(amended.data.subject, "Visit on Saturday");
  assert.equal(amended.status, "awaiting_review", "an edit must not decide the action");
  await service.decide("amend-user", proposal.id, amended.hash, "approve");
  assert.deepEqual(seen, [{ subject: "Visit on Saturday", body: "See attached." }]);
});

test("an amendment invalidates the hash it was reviewed under", async () => {
  // The whole security property of the hash. If the payload could change while
  // the hash survived, a reviewer would approve the text they read and something
  // else would be sent.
  const { service } = recorder();
  const proposal = await service.propose("hash-user", email);
  const amended = await service.amend("hash-user", proposal.id, proposal.hash, {
    body: "totally different",
  });
  assert.notEqual(amended.hash, proposal.hash);
  await assert.rejects(
    service.decide("hash-user", proposal.id, proposal.hash, "approve"),
    /changed/,
    "the superseded hash must no longer be able to approve",
  );
});

test("an amendment only changes the fields it names", async () => {
  // A patch is a patch, not a replacement: sending only the subject must not
  // silently drop the recipients.
  const { service } = recorder();
  const proposal = await service.propose("partial-user", email);
  const amended = await service.amend("partial-user", proposal.id, proposal.hash, {
    subject: "New subject",
  });
  assert.deepEqual(amended.data.to, ["sam@example.com"]);
  assert.equal(amended.data.body, "See attached.");
});

test("a decided action cannot be amended", async () => {
  const { service } = recorder();
  const proposal = await service.propose("decided-user", email);
  await service.decide("decided-user", proposal.id, proposal.hash, "deny");
  await assert.rejects(
    service.amend("decided-user", proposal.id, proposal.hash, { subject: "too late" }),
    /no longer open for review/,
  );
});

test("one person cannot amend another person's proposal", async () => {
  const { service } = recorder();
  const proposal = await service.propose("owner-a", email);
  await assert.rejects(
    service.amend("owner-b", proposal.id, proposal.hash, { subject: "not mine" }),
    /not found/,
  );
});

test("an amendment is validated against the proposal schema", async () => {
  // Otherwise the executor receives a payload nothing has checked, which is the
  // one thing the review gate exists to prevent.
  const { service } = recorder();
  const proposal = await service.propose("schema-user", email);
  await assert.rejects(
    service.amend("schema-user", proposal.id, proposal.hash, { to: "not-an-array" }),
    /Invalid|expected|array/i,
  );
  const saved = await db.get<ActionProposal>("schema-user", "actions", proposal.id);
  assert.deepEqual(saved?.data.to, ["sam@example.com"], "a rejected patch must not be stored");
});

test("an expired review cannot be amended", async () => {
  const { service } = recorder();
  const proposal = await service.propose("expired-user", email);
  await db.put("expired-user", "actions", {
    ...proposal,
    expiresAt: new Date(0).toISOString(),
  });
  await assert.rejects(
    service.amend("expired-user", proposal.id, proposal.hash, { subject: "zombie" }),
    /expired/,
  );
});

test("an amendment that loses the race with a decision does not resurrect it", async () => {
  // The compare-and-swap is what makes this safe. Check-then-write would let the
  // edit land on an action that had already been approved for execution.
  const finish = deferred<string>();
  const service = new ActionService(db, {
    execute: async () => finish.promise,
    connected: async () => true,
  });
  const proposal = await service.propose("race-user", email);
  const approval = service.decide("race-user", proposal.id, proposal.hash, "approve");
  await assert.rejects(
    service.amend("race-user", proposal.id, proposal.hash, { subject: "too late" }),
    /decided while it was being edited|no longer open/,
  );
  finish.resolve("sent");
  await approval;
  const saved = await db.get<ActionProposal>("race-user", "actions", proposal.id);
  assert.equal(saved?.data.subject, email.data.subject, "the edit must not have been applied");
});

test("an amendment cannot smuggle in a different kind of action", async () => {
  // `kind` selects the schema, the executor and the target version. Letting it
  // move through the data patch would let a review approved for one kind be
  // turned into an execution of another.
  const { service } = recorder();
  const proposal = await service.propose("kind-user", email);
  await assert.rejects(
    service.amend("kind-user", proposal.id, proposal.hash, {
      kind: "calendar.delete",
      eventId: "somebody-elses-event",
    }),
    /kind cannot be changed/,
  );
  const saved = await db.get<ActionProposal>("kind-user", "actions", proposal.id);
  assert.equal(saved?.kind, "email.send", "the kind must not have moved");
});

test("an amendment re-prepares so the target version is current", async () => {
  // A calendar update's target version is the event's own version. Reusing the one
  // captured when the agent first drafted would let an edit execute against a
  // stale read and silently overwrite someone else's change.
  const versions = ["v1", "v2"];
  let calls = 0;
  const service = new ActionService(db, {
    execute: async () => "updated",
    connected: async () => true,
    prepare: async () => {
      const targetVersion = versions[calls++];
      return {
        input: {
          kind: "calendar.update" as const,
          data: eventDraftSchema.and(z.object({ eventId: z.string().min(1) })).parse({
            eventId: "e1",
            title: "Standup",
            start: "2026-03-02T09:00:00Z",
            end: "2026-03-02T09:30:00Z",
            timeZone: "UTC",
          }),
        },
        target: { id: "e1", title: "Standup" } as never,
        targetVersion,
      };
    },
  });
  const draft = eventDraftSchema.and(z.object({ eventId: z.string().min(1) })).parse({
    eventId: "e1",
    title: "Standup",
    start: "2026-03-02T09:00:00Z",
    end: "2026-03-02T09:30:00Z",
    timeZone: "UTC",
  });
  const proposal = await service.propose("version-user", { kind: "calendar.update", data: draft });
  assert.equal(proposal.targetVersion, "v1");
  const amended = await service.amend("version-user", proposal.id, proposal.hash, {
    title: "Standup (moved)",
  });
  assert.equal(amended.targetVersion, "v2", "the edit must see the current version");
});

for (const decision of ["approve", "deny"] as const) {
  test(`an amendment before the atomic ${decision} claim rejects the old hash`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const originalClaim = db.claim.bind(db);
    let intercept = true;
    let executions = 0;
    const owner = `amend-before-${decision}`;
    const service = new ActionService(db, {
      connected: async () => true,
      execute: async () => {
        executions++;
        return "sent";
      },
    });
    const proposal = await service.propose(owner, email);
    db.claim = async (...args) => {
      if (intercept && args[0] === owner) {
        intercept = false;
        entered.resolve();
        await release.promise;
      }
      return originalClaim(...args);
    };
    try {
      const deciding = service.decide(owner, proposal.id, proposal.hash, decision);
      const rejection = assert.rejects(deciding, /proposal changed/i);
      await entered.promise;
      const amended = await service.amend(owner, proposal.id, proposal.hash, {
        to: ["changed@example.com"],
      });
      release.resolve();
      await rejection;
      const saved = await db.get<ActionProposal>(owner, "actions", proposal.id);
      assert.equal(saved?.status, "awaiting_review");
      assert.equal(saved?.hash, amended.hash);
      assert.equal(executions, 0);
      await service.decide(owner, proposal.id, amended.hash, "approve");
      assert.equal(executions, 1);
    } finally {
      release.resolve();
      db.claim = originalClaim;
    }
  });
}

test("CasaOS amendments use their own connection and execute the reviewed edit", async () => {
  let connection: { id: string; account: string } | null = { id: "casa", account: "owner" };
  let executedAction: unknown;
  const service = new ActionService(db, {
    connected: async () => true,
    connection: async (_, kind) => {
      assert.equal(kind, "casaos.action", "Google must not be selected for this action");
      return connection;
    },
    execute: async (_, input, connectionId) => {
      assert.equal(connectionId, "casa");
      assert.ok(input.kind === "casaos.action");
      executedAction = input.data.action;
      return "stopped";
    },
  });
  const proposal = await service.propose("casa-amend", {
    kind: "casaos.action",
    data: { app: "plex", action: "start" },
  });
  connection = null;
  await assert.rejects(
    service.amend("casa-amend", proposal.id, proposal.hash, { action: "stop" }),
    /connect CasaOS/i,
  );
  connection = { id: "replacement", account: "owner" };
  await assert.rejects(
    service.amend("casa-amend", proposal.id, proposal.hash, { action: "stop" }),
    /CasaOS connection changed/i,
  );
  connection = { id: "casa", account: "owner" };
  const amended = await service.amend("casa-amend", proposal.id, proposal.hash, { action: "stop" });
  assert.equal(amended.connectionId, proposal.connectionId);
  assert.equal(amended.account, proposal.account);
  const result = await service.decide("casa-amend", proposal.id, amended.hash, "approve");
  assert.equal(result.status, "succeeded");
  assert.equal(executedAction, "stop");
});
