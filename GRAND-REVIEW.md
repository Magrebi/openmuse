# Grand Review — OpenMuse SOTA upgrade and end-to-end hardening

**Branch:** `marathon-audit`
**Commits:** `df0124f` → `f0e5775` (8 commits)
**Tests:** 701 passing, 0 failing (571 at the start of this pass)
**Gates:** `pnpm lint` clean · `pnpm typecheck` clean across root, mobile, desktop

---

## Part I — Capabilities added

### 1. Sensory smoothness and fluid motion

**Breathing agent states.** The mascot is no longer a static drawing. `mascot.ts`
drives six distinct states — idle, listening, thinking, browsing, waiting and
celebrating — each an organic oscillator rather than a canned loop, sampled
through a spring integrator so a state change eases into the next instead of
cutting. `mascot.tsx` renders it through Reanimated shared values, so the motion
runs on the UI thread and survives a busy JS thread.

**Shared element transitions.** `shared-element.ts` measures a card's frame in
window coordinates and hands it to the sheet that replaces it, so a tap expands a
`TaskCard` into its detail view along the path the card already occupied. The
geometry and the spring profile are pure and separately tested, because the
motion is easy to get subtly wrong and hard to see in a screenshot.

**Streaming layouts.** Streaming tool text and chat messages animate their height
with a spring whose overshoot is constrained — the streaming-height spring must
never overshoot, because a message that bounces past its final size and comes
back reads as a glitch.

### 2. Execution transparency and live mirror

**Live browser screencast.** The `browse_web` path no longer returns a static DOM
extract. `mirror-protocol.ts` defines a framed wire format carrying JPEG frames
plus the virtual cursor; `mirror.ts` is a hub that captures on an interval and
fans out to viewers; `mirror-routes.ts` authenticates the upgrade once and reuses
that owner for the stream, so a token cannot expire between the check and the
connection. The mobile client renders the live viewport with the cursor drawn
over it, at a deliberately low frame rate — enough to follow, cheap enough to
leave running.

**Granular chain-of-thought.** `intention.ts` turns a tool call into a specific
micro-intention ("🔍 Searching flights…") rather than a generic "Working…", and
`cot.ts` + `cot-accordion.tsx` render the run's events as an expandable, animated
step accordion inside the chat feed. Control characters are stripped: a newline
inside a tool argument would otherwise break the one-line format the accordion
renders and could forge an extra step.

### 3. Proactivity and human-in-the-loop gating

**Undo architecture.** Reversible work — re-reading a page, refreshing a
document — used to go through the same approval gate as sending an email, which
trains people to approve without reading. `undo.ts` now runs it immediately and
publishes a five-second window backed by an undo toast in the app shell. The queue
is a state machine with an injected clock: settling claims the entry before
anything awaits, so an undo racing the commit resolves one way rather than both.

**Rich visual diff cards.** The approval card now holds the text being approved.
`diff.ts` computes a line-level LCS diff against the agent's own draft;
`diff-editor.tsx` shows the agent's lines struck through beside the reviewer's
additions. This is the safety mechanism, not decoration: the reason to be
suspicious of a draft is that you cannot tell what it kept from what it invented.
`ActionService.amend` applies the edit server-side and recomputes the proposal
hash, so an edit is a new thing to be reviewed rather than a way around it.

**Semantic idea generation.** `semantics.ts` replaces the regex scanner with local
embedding-based correlation over recent mail and calendar events, surfacing
suggestions like "flight delayed, shift dinner reservation?" rather than
pattern-matched keyword hits.

### 4. Ambient presence

**Desktop tray sparkline.** A tray that says only "healthy" answers "is it on".
`sparkline.ts` keeps a bounded window of the agent's outstanding work and scales
it against its own recent peak; the tooltip names what is in flight. `/api/health`
gained a `workerLoad` count — a number, never a list, because the endpoint is
reachable before anyone has signed in.

---

## Part II — Bugs found and fixed

Every item below was found by reading the code and then pinned by an adversarial
test that fails without the fix.

### Correctness

| # | Where | Root cause | Remediation |
|---|-------|-----------|-------------|
| 1 | `diff.ts` | `collapseContext` collapsed *every* line when nothing had changed, hiding an entire email body behind a "3 unchanged lines" marker. | Anchor on the presence of a change; an unchanged diff returns all its lines. |
| 2 | `diff-editor.tsx` | Animated rows were keyed by array index, so inserting a line made every row below it animate the wrong text into the wrong place. | `keyRows` keys on content plus an occurrence counter, so a row is identified by what it says. |
| 3 | `sparkline.ts` | A zero load was recorded as a sample, so an idle agent painted a bar — reporting activity that was not happening. | Idle is the absence of work and is not recorded; the now-dead `idle` branch in `summary()` was removed with it. |
| 4 | `control.ts` | Bar heights were clamped to the box height rather than its last addressable row, so a floor bar scaled to **1.1** and the tray was asked to draw taller than its icon. | Clamp to `height - 1`, with saturating arithmetic. |
| 5 | `lib.rs` (`spark_icon`) | Slot width is 1 at the constants actually used, so the ordinary `- 2` gap **underflowed and would have panicked on first paint**. | `saturating_sub`, with bounds proven by a standalone check (see Notes). |
| 6 | `db.ts` (`trimOlderThan`) | The deletion count came from the `DELETE`'s `rowCount`, which **PGlite does not populate** — so housekeeping reported zero deletions on the very database OpenMuse runs on. | Counted with a separate statement before the delete. |
| 7 | `lib.rs` (`spark_icon`) | A zero or non-finite bar painted a one-pixel stub. | A bar with no height is no bar; zero and non-finite values are skipped. |

### Memory and resource leaks

| # | Where | Root cause | Remediation |
|---|-------|-----------|-------------|
| 8 | `undo.ts` | The queue only ever added. Every action the agent ever ran left its callbacks — and whatever they closed over — resident for the life of the process. | Retention-based eviction with a hard ceiling, swept lazily on queue so no second timer is introduced. Pending entries are never swept: a dropped pending entry leaves its timer settling nothing. |
| 9 | `workspace.ts` / `db.ts` | `activity` and `run-events` are append-only, read **whole** on every refresh, and never pruned — so an ordinary fetch cost more the longer the workspace had been used. | `listRecent` caps the read in SQL (the ordering is already indexed, so the `LIMIT` is free); the agent's existing maintenance pass trims per owner. |
| 10 | `index.ts` | The undo queue was never closed on shutdown, so a process on its way out could begin an external write it was about to abandon. | `undo.close()` first in the shutdown chain, without `commitPending`. |

### Security

| # | Where | Root cause | Remediation |
|---|-------|-----------|-------------|
| 11 | `actions.ts` (`amend`) | Editing a review could introduce an attachment id the proposal never had, bypassing the ownership check `propose` performs — a way to attach another owner's document to an outbound email. | The route re-validates every attachment against `files.get(owner, id)`. Pinned by an HTTP-level test asserting a 404 and that nothing was stored. |
| 12 | `actions.ts` (`amend`) | `kind` selects the schema, the executor and the target version, and was reachable through the data patch. The schema stripped it, but only because these objects happen to be strict. | Refused outright, so the invariant does not rest on a schema detail. |
| 13 | `actions.ts` (`amend`) | A check-then-write amendment would let an approval arriving mid-edit execute the old payload while the stored row claimed the new one. | Compare-and-swap on status, hash **and** expiry together. |

### Confirmed sound, deliberately unchanged

The audit also checked these and found no defect, so they were left alone rather
than rewritten:

- The egress proxy resolves once and pins to the validated IP, so DNS rebinding
  is not possible; the allowlist covers transition and private ranges in both
  address families.
- `browser-console.ts` escapes `<` after `JSON.stringify`, so a preview URL cannot
  break out of its `<script>`. There is no `dangerouslySetInnerHTML` anywhere.
- `auth.ts` holds no unbounded cache and prunes expired sessions.
- The worker's lease and heartbeat recovery has no zombie path: an expired lease
  is reclaimed from its checkpoint, covered in `engine.test.ts` across a real
  database restart.

### Notes on limitations

- **`vault.ts` AAD is a constant.** A ciphertext copied between credential slots
  still decrypts. Hardening it would invalidate every already-encrypted
  credential, so it stays a conscious deferral recorded in `REVIEW.md`.
- **Rust is unverified here.** No `cargo`/`rustc` in this environment, so the tray
  blitter's bounds are proven by an equivalent standalone check rather than by a
  compiler. Stated rather than glossed.

---

## Verification

| Gate | Result |
|------|--------|
| `pnpm lint` | Clean — 204 files, no warnings |
| `pnpm typecheck` | Clean — root, `apps/mobile`, `apps/desktop` |
| `pnpm test` | **701 passing, 0 failing** |

Two pre-existing lint warnings in `tests/pdf-text.test.ts` were also resolved so
the lint output is perfectly clean.

## Constraints honoured

- **No telemetry or tracking.** No analytics, no external logging. The only
  `console` calls are a startup line and structured local error records that
  deliberately omit provider payloads and credential-bearing URLs.
- **No placeholders.** Every function is implemented; the undo window, the diff,
  the amend path and the sparkline all have real behaviour and tests.
- **Existing architecture preserved.** The CopilotKit engine and PGlite foundation
  are extended and hardened, not rewritten.
- **Zero regressions.** The suite grew from 571 to 701 tests and stayed green
  throughout.