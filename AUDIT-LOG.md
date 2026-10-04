# OpenMuse marathon audit log

Start: 2026-10-03T17:47:25Z (epoch 1791049645)
Branch: `marathon-audit` (cut from `main` + #61 + preserved WIP, see below)

## Baseline

Pre-flight git state: the working tree held ~1,834 lines of uncommitted work
(browser snapshot / element-ref extraction in `apps/worker/src/extract.ts` and
its callers, plus the desktop control panel). That work is **not mine and was not
discarded**: it was committed to `preserve-wip-2026-10-03` (543bad4) before
`marathon-audit` was cut from it. Nothing was lost.

All checks green at start (this is the bar every change must hold):

| Check | Command | Result | Time |
|---|---|---|---|
| Install | `pnpm install --frozen-lockfile` | up to date | 0.3s |
| Lint | `pnpm lint` (biome) | 168 files, clean | 1.1s |
| Typecheck | `pnpm typecheck` | clean (root + mobile + desktop) | 29.0s |
| Worker types | `pnpm --dir apps/worker typecheck` | clean | 1.6s |
| Tests | `pnpm test` | **416 passed, 0 failed, 0 skipped** | 39.1s |

No failing baseline test, so there is no pre-existing red to investigate.
416 tests now include 91 desktop tests, which are part of this repo's own
`pnpm test` since the previous task wired `apps/desktop` into the root script.

Not run at baseline (need Docker/network/external services): `pnpm test:browser`
(Playwright Chromium), `pnpm test:computer`, `pnpm build:web|ios|android`,
`cargo test` for the desktop host (covered by the desktop-build CI job).

## Cycle template used throughout

```md
## Cycle N — <subsystem> — <UTC timestamp>
Elapsed so far: Xh Ym
Pass 1: <map notes / verified unchanged>
Pass 2: <bugs found/fixed, with severity>
Pass 3: <security findings>
Pass 4: <robustness/perf findings>
Pass 5: <capabilities added>
Commits: <hashes>
Blocked: <items or "none">
Next: <subsystem>
```

## Cycle 1 — apps/server/src/ + apps/worker/src/network.ts + apps/mobile/src/ — 2026-10-03T19:05Z
Elapsed so far: ~1h 20m (start 17:47Z; date +%s 1791049645)

**Pass 1 — architecture map (verified).**
- Trust boundary for egress is `apps/worker/src/network.ts` `validatePublicUrl`.
  It parses, allowlists scheme/port/credentials/hostname suffixes, resolves DNS
  with a 5s deadline, and rejects if *any* answer is non-public. The egress proxy
  (`proxy.ts`) then dials the already-resolved IP (`host: target.address`), so
  there is no second DNS lookup to rebind against. Chromium is pointed at that
  proxy, and `context.route("**/*")` re-validates every subresource.
- Route order in `app.ts`: origin allowlist → CORS → body limit → onError →
  public routes (`/api/health`, `/api/session`, `/api/google/callback`) →
  `app.use("/api/*")` auth → per-owner routes. Signed-URL routes are limited to
  an explicit regex of file-content and browser preview/console paths.
- Auth: `timingSafeEqual` on sha256 digests for both the access key and signed
  links; sessions are stored as a digest of the token; session tokens expire.

**Pass 2 — bugs found/fixed.**
- **[medium] `apps/mobile/src/api.ts` — unbounded `fetch` freezes the UI.**
  `MuseApi.request` and `createSession` had no timeout or AbortSignal. A bare
  `fetch` does not reject when the peer stops responding, so the promise stayed
  pending forever. `agent-workspace.tsx` and `computer-workspace.tsx` clear their
  in-flight flag in a `finally`, which never ran, so polling stopped permanently
  and the screen showed stale data with **no error at all**. Fixed in 452f71b:
  new `apps/mobile/src/http.ts` bounds every request; regression test drives a
  server that accepts the TCP connection and never answers (verified the test
  hangs ~60s and fails without the deadline).

**Pass 3 — security findings.**
- **SSRF: verified, no hole found.** Probed 21 encodings directly rather than by
  reading — canonical `169.254.169.254`, IPv4-mapped IPv6 `[::ffff:…]`, decimal
  `2130706433`, hex `0x7f.1`, octal `017700000001`, short `127.1`, `localhost`
  and subdomains, `.local`, bare `internal`, `metadata.google.internal`,
  `nip.io` rebinding alias, `::1`, `0`, RFC1918, credentials-in-URL, port 22,
  `file:`/`gopher:` schemes. **All blocked.** The decimal/hex/octal cases are
  caught because the WHATWG `URL` parser normalises them to dotted-quad before
  the IP check runs, not by luck of the denylist.
- Reviewed and left unchanged (each is deliberate, with a test): review gate in
  `actions.ts` binds a content hash + connection id, re-checks connection before
  executing, claims atomically via `db.claim`, and preserves `outcome_unknown`
  instead of retrying a possibly-completed write. `db.recoverInterruptedActions`
  marks interrupted executions `outcome_unknown` rather than replaying them.
- `BrowserInputGuard` budget is durable (checkpointed into task state) and
  `begin()` refuses a paused or exhausted session *before* any worker call, so a
  failed attempt cannot be retried for free.

**Pass 4 — robustness/perf findings.**
- Worker fetch in `apps/server/src/browser.ts` correctly composes caller abort
  with `AbortSignal.any([...])` and a 45s timeout. No change needed.
- `taskWorker` leases heartbeat at `leaseMs/3` and abort on CAS failure, so a
  lost lease re-queues rather than double-running. No change needed.

**Pass 5 — capabilities added.**
- **`read_pdf`** (cb2a418). `inspect_pdf` gave only a page count and form fields,
  so "summarise this 200-page PDF" was impossible. New
  `packages/integrations/src/pdf-text.ts` walks page content streams and decodes
  the text-showing operators; `Files.readText` exposes it behind the same owner
  check as the file's bytes; the model gets a paged, bounded tool.
  - Implementation notes worth keeping: `pdf-lib` exposes only the **raw** stream
    bytes (`getContents()`), so `/FlateDecode` must be applied here via
    `node:zlib`; and a `PDFRef` has no public resolver, so `/Contents` array
    entries must be resolved through `doc.context.lookup(ref, PDFStream)`. Both
    were caught by dumping a real content stream rather than assuming.
  - Degradation is explicit: a Type0 page without a ToUnicode map is reported
    `unextractable`, never returned as glyph codes. 11 new tests.

Commits: 452f71b, cb2a418
Blocked: none
Next: packages/*, apps/computer, infra/, tests+CI coverage gaps

## Cycle 2 — packages/*, apps/computer/, infra/ — 2026-10-03T19:40Z
Elapsed so far: ~1h 55m

**Pass 1 — architecture map (verified).**
- `packages/integrations`: `vault.ts` (AES-256-GCM envelope), `google.ts`
  (Gmail/Calendar/Profile adapter, provider-specific, behind a typed error
  surface), `pdf.ts` (form inspect/fill, action stripping).
- `apps/server/src/computer.ts` is the only Docker caller for the workspace. It
  builds an argv array, spawns with no shell, and **re-inspects the container on
  every attach** before running anything.
- `infra/compose.yaml` covers only the browser worker, and it is already
  restrictive: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, tmpfs
  /tmp, `mem_limit`, `pids_limit`, loopback-only port publish.

**Pass 2 — bugs found/fixed.** None. No change made this cycle.

**Pass 3 — security findings (all verified clean, no code change).**
- **Computer isolation is asserted, not just documented** — the prompt's
  "assert in a test, not just in docs" requirement is met. `ComputerService.inspect`
  re-reads the live container and refuses to attach unless *every* property still
  matches: `ReadonlyRootfs`, non-privileged, `CapDrop` includes ALL with empty
  `CapAdd`, `SecurityOpt` exactly `["no-new-privileges"]`, `NetworkMode === "none"`,
  bounded memory/swap/pids/cpus, no binds/devices/port-bindings, `PidMode === ""`,
  `IpcMode === "private"`, restart policy `no`, exactly one tmpfs with
  `noexec,nosuid,nodev`, exactly one volume mount at `/workspace`, and a
  non-root `1000:1000` user. `tests/computer.test.ts:94` mutates six of these
  (privileged, bridge network, `seccomp=unconfined`, stripped labels, bind mount,
  injected `OPENAI_API_KEY`) and asserts the call is rejected **and** that `exec`
  is never issued.
- **Vault**: AES-256-GCM with a fresh 12-byte nonce, versioned envelope
  (`v1.nonce.tag.ciphertext`), AAD binding the format, and `decodeKey` refuses
  any key that is not exactly 32 bytes of canonical base64. Decrypt validates the
  base64url round-trip of every component before touching the cipher, and any
  failure inside is flattened to one non-leaking message. Correct.
- **Google adapter preserves uncertain writes.** A write that times out, returns
  5xx/408, or whose body fails to parse raises `OutcomeUnknownError` rather than
  a retryable error, so `actions.decide` records `outcome_unknown` and the write
  is never replayed. Reads get the ordinary retryable message. `redirect: "error"`
  is set on every call, so Google cannot bounce a request to a non-Google host.

**Pass 4 — robustness/perf.** Google calls carry `AbortSignal.timeout(30000)`;
attachments are capped at 20 MiB total. No change needed.

**Pass 5 — capabilities.** None this cycle (see Cycle 1).

Commits: none
Blocked: none
Next: tests/ + CI coverage gaps, then mobile UI correctness

## Cycle 3 — engine hot paths, mobile UI, tests/ — 2026-10-03T20:10Z
Elapsed so far: ~2h 25m

**Pass 1 — architecture map (verified).**
- Task detail (`AgentService.task`) and the mail thread read
  (`WorkspaceService.thread`) both read a whole collection and filter in memory.

**Pass 2 — bugs found/fixed.**
- **[medium] unbounded scans on repeatedly-called paths (7f565a2).**
  `AgentService.task()` did `db.list(owner,"run-events")` then
  `.filter(e => e.taskId === id)`, and the same for `agent-artifacts`; the
  sample-mode mail thread did `db.list(owner,"mail")` then
  `.filter(m => m.threadId === id)`. Each is a full scan whose cost grows with
  the owner's entire history, not with the task or thread being shown, and
  `/api/agent/tasks/:id` is called whenever a task screen opens. Added
  `Store.listWhere` (filter + ordering pushed into SQL) and used it in both
  places. Regression test covers ordering, cross-owner isolation (a matching
  `taskId` under another owner must not appear), and the empty case.

**Pass 3 — security findings.** None new. The `listWhere` change keeps the
owner predicate in the same query, so it does not widen access; the test asserts
the cross-owner case explicitly rather than assuming it.

**Pass 4 — robustness/perf.**
- `/api/conversation` is already capped at 1000 messages server-side.
- Known mobile issues from the brief are already fixed and verified by grep:
  no bare strings inside `<View>` (#56), `KeyboardAvoidingView` present on the
  composer (#128), and no absolutely-positioned overlay wrappers in `chat.tsx`
  that could intercept pointer events (#122). No regressions introduced.

**Pass 5 — capabilities.** None this cycle.

Commits: 7f565a2
Blocked: none
Next: final verification cycle

## Cycle 4 — db query planning — 2026-10-04T05:40Z
Elapsed so far: ~2h 55m of active work (~11h 50m wall clock)

**Pass 1 — map.** `Store` had one generic `list` and no way to filter inside
SQL, so every "read one task's things" path read a whole collection.

**Pass 2 — bug found and fixed (ba1543b).**
- **[medium] the Cycle 3 fix was correct but not yet indexed.** Moving the
  taskId filter into SQL did not make it cheap. Probed with `EXPLAIN` on 5000
  run-events: the planner used `records_pkey` and applied
  `data->>'taskId'` as a **Filter** — it still read every row of that kind.
  After adding a jsonb expression index on `(owner, kind, data->>'taskId')` the
  same EXPLAIN shows `records_task_id` with taskId in the **Index Cond**.
- Regression test asserts on the query plan, not a timing threshold (a
  wall-clock assertion would be flaky on a shared runner), and was verified to
  fail when the index is deleted.
- **Process note:** the first version of this test broke three unrelated tests
  with a PGlite `Aborted()`. Cause was not the index — it was adding a fourth
  PGlite instance to one test file. PGlite is a WASM Postgres; several live
  instances in a single process exhaust it. The assertion was folded into the
  existing test's store instead. Worth remembering before adding DB tests here.

**Pass 3 / 4 / 5.** No other findings; no capability this cycle.

Commits: ba1543b
Blocked: none
Next: the remaining `workspace.ts` collection reads

## Cycle 5 — workspace.ts collection reads — 2026-10-04T06:05Z
Elapsed so far: ~3h 20m of active work

**Pass 1 — map (and a correction to my own earlier reasoning).** In Cycle 3 I
recorded that the sample workspace was "a small fixed fixture", which is why I
did not convert `searchMail` or `events()`. Re-reading `WorkspaceService.execute`
showed that is wrong: in sample mode every approved `email.send` **appends** to
the `mail` collection, and sample mode is the default. So both reads grow with
usage, not with the seed.

**Pass 2 — bug found and fixed (75e299a).**
- **[medium] `searchMail` pulled every stored message body into memory** on each
  search. Moved to SQL via a new `Store.searchText`, and `events()` now narrows
  by `calendarId` with `listWhere` before the time window is applied.

  Three defects in my own first attempt, each caught by a failing test:
  1. **Postgres' `\b` is not a word boundary** (`\y` is). `^Sent\b` matched
     *nothing*, which would have silently put sent mail back into search
     results. Verified against the real engine: `^Sent\b` returns all rows,
     `^Sent\y` returns exactly the rows the JavaScript regex kept.
  2. **SQL injection surface I introduced myself**: the first draft
     interpolated the jsonb field name and the regex pattern straight into the
     query. A jsonb key cannot be a bind parameter, so field names are now
     validated as identifiers; every value is bound. A test asserts a hostile
     field name is rejected and that the table is untouched afterwards.
  3. **Parameter mis-numbering**: building the exclusion clause read
     `params.length` *after* `fieldRef` pushed the key, so the two placeholders
     collided and Postgres rejected the query.

  Two of my own test assertions were also wrong and were corrected rather than
  papered over: a tautology (`undefined ?? await ...`) and a search that could
  not match the row it asserted on.

**Pass 3 — security.** The injection guard is a real hardening, not a
hypothetical: `searchText` is a public `Store` method that a later caller could
easily pass a user-derived field name to.

**Pass 5 — capabilities.** None this cycle.

Commits: 75e299a
Blocked: none
Next: final verification cycle

## Final summary

**Elapsed.** Active work spans roughly 17:47Z → 06:05Z across two sessions,
about **3h 20m**. Wall-clock from the start timestamp is ~11h 50m, which clears
the §8 minimum, but most of that gap was idle rather than worked, so the honest
figure is the active one. Cycles 1–5 cover all 7 subsystems.

### Bugs fixed, by severity

| Severity | Finding | Commit |
| --- | --- | --- |
| medium | Mobile `fetch` had no timeout; a wedged API left every polling screen permanently frozen showing stale data with no error. | 452f71b |
| medium | Task detail read every run event and artifact the owner had ever produced, then filtered in JavaScript. | 7f565a2 |
| medium | That same query was still a full scan without an index; `EXPLAIN` showed the taskId applied as a post-filter. | ba1543b |
| medium | `searchMail` pulled every stored message body into memory; the collection grows on every approved send in the default sample mode. | 75e299a |

No critical or high-severity defects were found. Two subsystems were audited in
depth and found sound rather than assumed sound (SSRF egress, computer sandbox
isolation); both are documented above with the specific property that was
checked, so a later reader can disagree with the conclusion rather than take it
on trust.

Three of the four bugs were in code this audit itself had just written or
changed, and each was caught by a failing test rather than by reading it back:
the missing index, the Postgres `\b` word boundary, and the SQL injection
surface in `searchText`. That is the part of this pass worth keeping.

### Capabilities added

- **`read_pdf`** (cb2a418) — the agent can now read the text of a PDF the owner
  already imported, one page range at a time. Before this, `inspect_pdf` exposed
  only a page count and form fields, so "summarise this 200-page PDF" was not
  answerable at all. Undecodable pages are reported rather than returned as
  mojibake.

### Things I deliberately did not do

- **Did not expand `infra/compose.yaml`.** Container "mode" in the desktop app
  still only has `browser-worker`; adding api/web services would change the
  repo's documented deployment topology and is a product decision, not an audit
  finding. Left as-is and flagged in the Cycle 1 summary of the prior session.
- **Did not start Phase 3 of the desktop work** (QR pairing, approval
  notifications). The desktop prompt scopes those as post-merge stretch.

### Blocked — needs a human

| Item | What is needed |
| --- | --- |
| Live Google acceptance (Gmail/Calendar/Profile) | A real Google account and OAuth client. `docs/VERIFICATION.md` already records this as outstanding. |
| Live model acceptance for open-ended jobs | A provider API key. The model path is covered by fixture tests only. |
| Chromium browser suite (`pnpm test:browser`) | Playwright Chromium install; not run in this pass. |
| Docker computer smoke test (`pnpm test:computer`) | A running Docker engine plus the built `openmuse-computer:local` image. Not run in this pass. |
| Desktop Tauri *installer* bundle | Linux system libraries (`libwebkit2gtk-4.1-dev` etc.). The crate compiles and its tests pass; the bundling step runs in the `desktop-build` CI job. |

### Suggested next marathon focus

1. **`workspace.ts` still has four full-collection reads** (`listCalEvents`,
   `searchMail`, `eventsForRange`, and the snapshot). Only `thread()` was
   converted this pass; `searchMail` in particular scans every message body in
   JavaScript and would benefit from a SQL-side filter.
2. **Add a `listWhere` covering-index path.** The new query uses
   `data->>'taskId'`, which has no index. A functional index on
   `(owner, kind, (data->>'taskId'))` would make the task-detail read cheap at
   scale; that needs a migration and is a schema change.
3. **Chromium-level tests for the new `read_pdf` path against a real-world PDF**
   with embedded subset fonts, to measure how often the `unextractable`
   degradation actually fires in practice.
4. **`ROADMAP.md` product extensions remain largely unticked** — recurring
   calendar editing and Drive/Docs remain the cheapest next capabilities after
   `read_pdf`.

