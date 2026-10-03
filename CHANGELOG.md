# Changelog

## Unreleased

- `read_pdf` lets a delegated task read the text of a PDF the owner already imported, one page range at a time, so a long document can be worked through instead of guessed at. Text is extracted server-side from the document's own embedded text by walking its page content streams. Output is bounded per page and per read, and a page the extractor cannot decode is listed as unreadable rather than returned as mojibake, so the agent is never handed glyph codes to summarise. Extracted text is document content, not instruction.

- A desktop app for running OpenMuse without a terminal. It is a control surface over the existing deployment, not a second configuration store: canonical state stays in `.env`, the Compose files and the API. One deployment state machine (`unknown → stopped → starting → healthy | degraded | error → stopping`) drives the tray icon, the status page and the OS notifications, and it is driven only by Compose exit codes and `GET /api/health`. Start, stop, health and per-service logs run through `docker compose` with argument arrays and never a shell string, stopping never passes `-v` so browser profiles and downloads survive a restart, and every prerequisite failure reports one actionable line. A re-runnable setup wizard generates missing secrets with the OS CSPRNG and writes `.env` in place behind a reviewable diff, preserving any secret that is already valid. See [apps/desktop](apps/desktop/README.md) and its [threat boundary](apps/desktop/SECURITY.md).

- `browser_wait` lets the agent let a page finish arriving before reading it: `idle` for network quiet, `text` for the document to complete, `element` for a named ref to appear, or a bounded `delay`. A wait changes nothing on the page, so it spends no action budget.
- `browser_tabs` opens, switches, closes and lists a session's tabs, so the agent can keep two sources open and compare them without losing either. Every other action applies to the active tab and switching re-arms the session for the page on screen. A session holds at most 8 tabs, a page that opens its own window is closed rather than adopted, and the last remaining tab is never closed.
- `browser_upload` attaches a file the user already has to a file input. The file is named rather than carried: the worker resolves it inside the session's own folder, so an upload can only offer a file the owner stored, and a sign-in page refuses it outright.
- The agent's browsing moved from blind coordinate clicking to addressing real elements. `browser_snapshot` describes the page as text plus numbered elements (`e1`, `e2`, …) for links, buttons, fields, checkboxes and dropdowns, and `browser_click`, `browser_fill`, `browser_select` and `browser_check` act on those refs. A ref belongs to the document that issued it, so one from a page that has navigated is refused with `STALE_REF` rather than landing on a different element, and the worker accepts no caller-supplied selector.
- `search_web` lets the agent find pages it was not given a URL for. It runs inside the worker's own browser under the same public-URL, DNS and egress checks as any navigation; a redirect wrapper is unwrapped so the agent gets the real destination, and a non-HTTP(S) result is dropped.
- `browser_back` adds fixed `back`, `forward` and `reload` history moves, so an agent can revisit a page it navigated away from instead of only moving forward.
- A password field is now refused at the point of action, not only by the text it was about to receive: the worker rejects `input[type=password]` on `fill` even when the server is bypassed, and the server refuses a field the snapshot described as a password box before spending a round trip.
- The delegated agent can now operate a public web page it is reading, with `browser_scroll`, `browser_key`, `browser_click` and `browser_type` behind server-enforced guardrails: a 25-action per-task budget, a same-origin scope that freezes input when a page navigates elsewhere, durable `browser_input` receipts, credential refusal, and a gate that pauses for the user at any purchase, payment or reservation step.
- Interactive logins, credential entry and transactional submit are unchanged: the agent never types a password and never checks out, so those still route to the user through the takeover console.
- Browser input is validated in the API before the worker is called, reusing the worker's own bounds, key whitelist and rejection wording.

## 0.1.0-alpha — 2026-09-15

Initial public OpenMuse alpha.

- Native/web interface using CopilotKit React Native and AG-UI.
- Persistent browser computer, inline PDFs, structured artifacts, and optional Rich Threads integration.
- Durable delegated tasks, reviews/receipts, Ideas, Goals, Tracking, and editable memory.
- Google adapters, supported PDF workflows, and CSV spending summaries.
- Disabled, contract-tested OpenBot adapter for future backend integration.
- Native walkthrough recording, contributor docs, and CI for tests, builds, and real Chromium.
- Fixed Ideas suggesting sent replies or already completed matching work; restored task delegation in the persistent menu.

See [verification](docs/VERIFICATION.md) for actual coverage and [roadmap](ROADMAP.md) for incomplete integrations.
