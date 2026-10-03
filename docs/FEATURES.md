# OpenMuse feature inventory

The native and web agent core runs locally. This inventory describes the current implementation and remaining extensions. Live providers and optional infrastructure require separate configuration and validation.

## Implemented coverage

| Area | Current implementation | Remaining extension |
| --- | --- | --- |
| Chat / delegated work | Native CopilotKit chat, server tools, durable tasks and confirmed outcomes | Live model/provider acceptance testing |
| Ideas / personal context | Source-backed mail/goal rules, accept/edit/dismiss, identity, editable/forgettable memories | Broader model-derived cross-connector suggestions |
| Goals / Tracking | Milestones, recurring watches, observations, retry/backoff, pause and cancellation | Adaptive long-term planning and calendar-driven reminders |
| Browser | Persistent Chromium, public page reads, snapshots, console takeover, agent scroll/click/type with guarded input receipts, PDF downloads | Automatic checkout and per-person VM orchestration |
| Linux computer | Nonroot Docker container, bounded bash/Python/Node/git commands, saved output and exit receipts, persistent workspace files, text editing, PDF import/export | Interactive terminal, desktop apps, controlled egress, disk quotas and stronger VM isolation |
| Gmail / Calendar | Google OAuth; complete threads; saved drafts; calendar/event CRUD with reviewed versions | Live Google acceptance, recurrence editing, other connectors |
| PDF job | Durable import, typed input request, filled-copy preview, reviewed reply, receipt | OCR/scanned forms and additional PDF field types |
| Generated results | Plans/reports/comparisons, finance CSV metrics, and scripts in the private Linux workspace | Managed tool installation/versioning and image/audio generation |
| Notifications | Durable in-app inbox, source-linked change alerts, restart reconciliation | APNs/FCM/device push delivery |
| Connectors | Searchable capability/status catalogue, Google connection, browser worker | Plaid, health, Instagram, WhatsApp and partner APIs |
| OpenBot | Disabled adapter with pinned protocol/identity tests | Live session bridge, routines and computer backend wiring |

The Linux computer is disabled until configured on the server and has no network access. It is a single-owner container with a persistent `/workspace`, separate from the browser worker; see [computer setup and limits](COMPUTER.md). It is not a graphical desktop or a full OS VM.

## Agent-operated web pages

After `read_web` or `browser_snapshot`, a delegated model task can operate that page with these server tools:

| Tool | Input | Result |
| --- | --- | --- |
| `browser_snapshot` | none | Page text plus numbered elements (`e1`, `e2`, …) and links |
| `browser_click` | `ref`, or `x`/`y` in the 1280 × 800 screenshot | Refreshed page text plus a screenshot URL |
| `browser_fill` | `ref`, `text` at most 10,000 characters | Refreshed page text plus a screenshot URL |
| `browser_select` | `ref`, `value` from the snapshot's options | Refreshed page text plus a screenshot URL |
| `browser_check` | `ref`, `checked` | Refreshed page text plus a screenshot URL |
| `browser_upload` | `ref`, `file` name of a file the user already has | Refreshed page text plus a screenshot URL |
| `browser_wait` | `until`: `idle`, `text`, `element` (with `ref`), or `delay` (with `ms`) | Refreshed page text plus a screenshot URL |
| `browser_tabs` | `action`: `list`, `open` (with `url`), `switch` or `close` (with `index`) | The open tabs and which is active |
| `browser_scroll` | `deltaY`, at most ±5000 | Refreshed page text plus a screenshot URL |
| `browser_key` | One whitelisted navigation key | Refreshed page text plus a screenshot URL |
| `browser_type` | `text`, at most 10,000 characters | Refreshed page text plus a screenshot URL |
| `browser_back` | `to`: `back`, `forward` or `reload` | Refreshed page text plus a screenshot URL |
| `search_web` | `query`, at most 300 characters | Result titles, destination URLs and snippets |

Discovery and addressing:

- **Search.** `search_web` finds pages the agent was not given a URL for. It runs through the worker's own browser and the same public-URL checks as any navigation; a redirect wrapper is unwrapped so the agent receives the real destination, and a non-HTTP link is dropped.
- **Element refs.** `browser_snapshot` stamps a short ref (`e1`, `e2`, …) onto each visible link, button, field, checkbox and dropdown, and reports its role and accessible name. Actions address that ref instead of guessing a pixel, which is what makes reliable interaction on real pages possible.
- **Stale refs fail loudly.** Refs belong to the document that issued them. After a navigation the old refs are gone, so an action against one is refused with `STALE_REF` rather than silently landing on a different element.
- **Coordinates remain** for pages a snapshot cannot describe, such as a canvas-drawn control.
- **Waiting.** Pages fetch and render after the click that triggered them, so `browser_wait` is how the agent lets one arrive before reading it: `idle` for network quiet, `text` for the document to complete, `element` for a specific ref to appear, `delay` for a bounded pause. It changes nothing on the page and therefore spends no budget.
- **Tabs.** A session holds up to 8 tabs. `browser_tabs` opens, switches, closes and lists them, which is how the agent compares two sources without losing either. Every other action applies to the active tab, and switching re-arms the session for the page now on screen. A page that opens its own window is closed rather than adopted, and the last remaining tab is never closed.
- **Upload.** `browser_upload` attaches a file the user already has to a file input. The worker resolves the name inside the session's own folder, so bytes never travel in a request and the agent cannot offer a file it was not given.

Each action is written to task evidence as a `browser_input` receipt recording the action, its parameters, the URL before and after, and the time. Invariants:

- **Budget.** At most 25 input actions per delegated task. The count is durable, so it survives a restart, and every result reports the remaining budget. Reading, searching, snapshotting, waiting and switching tabs are observations and do not spend it.
- **Same-origin scope.** Input is scoped to the origin the session was observed on. If an action navigates elsewhere, input freezes until the agent calls `read_web` again. Switching tabs is treated as an observation, so it re-arms for the page now on screen rather than freezing.
- **No credentials.** `browser_fill`, `browser_upload` and `browser_type` refuse credential-shaped text, refuse a field the snapshot described as a password box, and refuse outright on a sign-in page. The worker refuses a password field at the point of action too, so the rule holds even if the server is bypassed. Sign-in, password and payment entry always hand back to the user through the takeover console.
- **Uploads are named, never carried.** An upload names a plain file the session owner already stored; the bytes never travel in a request. Separators, traversal and absolute paths are refused, and the worker's own check is the final authority.
- **Transactional submit gate.** When a page after an action looks like a purchase, payment or reservation step, the task pauses and asks the user to confirm. The agent never adds to a cart, checks out, or submits a transaction.
- **Uncertain outcomes.** An input that fails or times out is recorded as uncertain and is never replayed. Because the page may already have changed, further input pauses until the agent reads the page again, so a failing worker cannot be retried in a loop.
- **No caller-supplied selectors.** The worker never runs a selector or script from a request. Every action names an element the snapshot itself offered, which is why a ref cannot reach an element the agent was never shown. A wait names a fixed verb or a ref; it takes no selector either.

Not supported: automatic checkout, payment submission, reservation booking, credential entry, or any third-party vendor integration.

The implementation and validation details are in [VERIFICATION.md](VERIFICATION.md). Planned extensions are not claims of current support. Priorities are tracked in the [roadmap](../ROADMAP.md).
