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

After `read_web`, a delegated model task can operate that page with four server tools:

| Tool | Input | Result |
| --- | --- | --- |
| `browser_scroll` | `deltaY`, at most ±5000 | Refreshed page text plus a screenshot URL |
| `browser_key` | One whitelisted navigation key | Refreshed page text plus a screenshot URL |
| `browser_click` | `x`, `y` inside the 1280 × 800 screenshot | Refreshed page text plus a screenshot URL |
| `browser_type` | `text`, at most 10,000 characters | Refreshed page text plus a screenshot URL |

Each action is written to task evidence as a `browser_input` receipt recording the action, its parameters, the URL before and after, and the time. Invariants:

- **Budget.** At most 25 input actions per delegated task. The count is durable, so it survives a restart, and every result reports the remaining budget.
- **Same-origin scope.** Input is scoped to the origin the session was observed on. If an action navigates elsewhere, input freezes until the agent calls `read_web` again.
- **No credentials.** `browser_type` refuses credential-shaped text, and refuses outright on a sign-in page. Sign-in, password and payment entry always hand back to the user through the takeover console.
- **Transactional submit gate.** When a page after an action looks like a purchase, payment or reservation step, the task pauses and asks the user to confirm. The agent never adds to a cart, checks out, or submits a transaction.
- **Uncertain outcomes.** An input that fails or times out is recorded as uncertain and is never replayed. Because the page may already have changed, further input pauses until the agent reads the page again, so a failing worker cannot be retried in a loop.

Not supported: automatic checkout, payment submission, reservation booking, credential entry, or any third-party vendor integration.

The implementation and validation details are in [VERIFICATION.md](VERIFICATION.md). Planned extensions are not claims of current support. Priorities are tracked in the [roadmap](../ROADMAP.md).
