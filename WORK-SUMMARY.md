# Work summary — uncommitted correctness pass

**Date:** 2026-10-04
**Branch:** `marathon-audit`
**Base commit:** `34e3728` — *marathon: docs — record cycles 4 and 5 and the corrected elapsed figure*
**State:** 9 files modified, **uncommitted** (+421 / −13)

These are hardening fixes to code the earlier audit cycles introduced or touched. Each
one is a defect that produced a *wrong answer* rather than a crash, so each is paired
with a regression test that fails without the fix.

---

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | 173 files, 0 errors, 4 infos — **all 4 pre-existing in `HEAD`**, this change adds none |
| Typecheck | `pnpm typecheck` | clean (root + mobile + desktop) |
| Tests | `pnpm test` | **442 passed, 0 failed, 0 skipped** (9 new cases) |

> Lint note: the new `pdfWithStream` test helper initially introduced 3 `useTemplate`
> infos. Those were rewritten as template literals. The 4 remaining infos are in the
> pre-existing Type0-font fixture from `cb2a418` and were deliberately left alone to
> keep this diff focused on the fixes.

---

## 1. Sessions were never collected — `auth.ts`, `db.ts`

Nothing in the app ever deleted a `sessions` row. Every sign-in added one, and each
retained a **bearer-token digest long past its 24-hour expiry**, growing monotonically.
(This was also finding **L1** in `REVIEW.md`.)

- **`db.ts` — new `Store.pruneExpired(owner, kind, now)`.** Deletes rows of one kind
  whose numeric `expiresAt` has passed. The predicate is anchored
  (`data->>'expiresAt' ~ '^[0-9]+$'`) so a row missing `expiresAt` or holding something
  else is skipped rather than raising and taking every other row down with it.
- **`auth.ts` — `session()` prunes on sign-in.** Signing in is the one moment sessions
  are known to be collectable, and it is rare, so it is the natural trigger. A prune
  failure is logged through `backgroundFailure` and never refuses a valid sign-in —
  stale rows are a cleanup problem, not an auth failure.
- **`auth.ts` — `owner()` drops the row of a lapsed token.** The token is already
  unusable, so deleting its row changes no decision and stops the digest outliving the
  session it stands for.

## 2. A failed claim reported a decision that never happened — `actions.ts`

`ActionService` returned the current record when the atomic claim lost the race. If the
row was *still* `awaiting_review`, that means the claim never matched the stored row at
all — yet the caller received `200 OK` and could reasonably read it as "accepted".

Now a record still awaiting review raises `409` naming the real remedy ("Create a fresh
proposal"). A genuinely concurrent decision still returns the newer record as before.

## 3. One malformed row aborted the whole claim statement — `db.ts`

`Store.claim` cast `(data->>'expiresAt')::timestamptz` directly. An action with a
missing or non-date `expiresAt` made the cast raise, which aborted the statement and
surfaced as an opaque `502` rather than "this action cannot be claimed".

A regex pre-filter now restricts the cast to values that actually look like ISO-8601.
Unusable rows simply do not claim; well-formed rows are unaffected.

## 4. Search words carried their own wildcards — `db.ts`

`searchText` interpolated each word straight into a `LIKE` pattern. `%`, `_` and `\` are
wildcards to Postgres, so searching `100%` matched **every** body starting with `100`,
and — because backslash is itself the default escape character — searching `a\zb`
dropped the row that genuinely contained it and returned an unrelated one.

`likeEscape()` now escapes `\ % _` before the pattern is built. Case folding and the
all-words-AND rule are unchanged.

## 5. `listWhere` silently reversed artifact ordering — `db.ts`, `engine/service.ts`

`listWhere` hard-coded `ORDER BY data->>'date'`, but records of one kind do not share a
time field: a run event has `date`, an agent artifact has only `createdAt` *inside its
json*. Kinds with no `date` collapsed to `id` order, which flipped artifact lists from
newest-first to oldest-first.

- `db.ts` — added a named `ListOrder = "date_asc" | "updated_desc"`, resolved through a
  fixed `ORDER_SQL` map so **no caller-supplied text can reach the `ORDER BY` clause**.
  `updated_desc` sorts the column the store maintains itself, so it is correct for any
  record shape.
- `engine/service.ts` — the task-detail artifact read now asks for `updated_desc`,
  restoring the order the previous full `list` produced. Run events keep `date_asc`.

---

## 6. PDF text extraction — `pdf-text.ts`, `engine/model.ts`

Four defects, all of which made a readable page look unreadable or crashed the read:

| # | Defect | Fix |
| --- | --- | --- |
| a | `String.fromCharCode(...bytes)` passes **one stack frame per byte** and throws `RangeError` past ~125 KB — ordinary for a vector-heavy page, surfacing as "the document is malformed" | Chunked Latin-1 decode (`LATIN1_CHUNK = 8192`); identical output, off the stack limit |
| b | `inflateSync` was unbounded — a small upload could inflate to gigabytes and exhaust the process | `maxOutputLength: MAX_STREAM_BYTES` (32 MB); over the cap the stream degrades to `unextractable`, which is the honest answer anyway |
| c | `to` was not bounds-checked, so a range running past the end **invented** empty entries and reported them to the model as unreadable pages | `to > pages.length` now throws the same `RangeError` as `from` |
| d | Pages cut off by the per-read budget were reported as `unextractable: true`, telling the agent a perfectly readable page was a scan | New `budgetExhausted` flag, explicitly *not* `unextractable` |

**(d) also required an engine change.** `read_pdf`'s result now carries
`pagesNotRead: number[]` alongside `unreadablePages`, and the delegated-agent prompt
explains the distinction, so the agent re-reads that range instead of guessing at its
contents.

---

## Tests added

| Test | File |
| --- | --- |
| expired sessions are collected instead of accumulating forever | `tests/api.test.ts` |
| `searchText` treats a word's own wildcards as ordinary characters | `tests/persistence.test.ts` |
| `claim` never lets an unusable `expiresAt` through or abort the statement | `tests/persistence.test.ts` |
| `pruneExpired` clears lapsed rows and leaves everything else alone | `tests/persistence.test.ts` |
| a page whose content stream exceeds the argument limit still yields its text | `tests/pdf-text.test.ts` |
| a stream that expands past the cap is refused rather than exhausting memory | `tests/pdf-text.test.ts` |
| a compressed page under the cap is still read | `tests/pdf-text.test.ts` |
| a range running past the last page is refused rather than inventing pages | `tests/pdf-text.test.ts` |
| running out of budget is reported apart from an undecodable page | `tests/pdf-text.test.ts` |

The PDF fixtures are hand-written rather than built with `pdf-lib`, because `pdf-lib`
rebuilds a page on save and so cannot inject a content stream of a chosen size — which
is exactly what the stack-overflow and decompression-bomb tests need. The bomb fixture
asserts it is genuinely highly compressible before relying on it.

---

## Not done / out of scope

- **Nothing is committed.** All 9 files remain working-tree changes on `marathon-audit`.
- **`REVIEW.md` is untracked and untouched.** It is a read-only review of the separate
  `casaos-manager-v2` branch produced by an earlier session, not part of this work. Its
  findings **M1–M3** (CasaOS cleartext default address, name-based protected-app guard,
  best-effort log redaction) remain open — they are branch-specific and cannot be fixed
  from this branch.
- **Finding L2 from `REVIEW.md` is also still open here**: `Store.scan()` is an unindexed
  cross-owner full-table read on a 1-second worker tick. Fixing it needs a covering index
  on `(owner, kind)`, which is a schema migration rather than a code fix.
- **No new lint debt was taken on**, and no pre-existing code was reformatted beyond the
  new test helper.
