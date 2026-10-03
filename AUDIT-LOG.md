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

## Cycle template

```
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
