# OpenMuse roadmap

The release is a personal-agent alpha: delegate a job, inspect its plan, supply missing information, review an action, and return to a saved result. The [reference inventory](docs/FEATURES.md) is broader than this release.

## Shipped locally

- CopilotKit React Native chat and rich task/artifact cards on iOS, Android, and web.
- Server-owned jobs, plans, checkpoints, leases, retries, cancellation, and action receipts.
- Ideas with evidence, Goals, milestones, public-page tracking, and an in-app notification inbox.
- Persistent Chromium sessions, public-page reading, screenshots, manual interaction, and PDF downloads.
- Agent-operated interactive web pages: a search tool, page snapshots that describe links and controls as addressable elements, wait-for-page, multiple tabs, and scroll, click, fill, select, check, upload and history moves behind a same-origin scope, a 25-action per-task budget, durable input receipts, and a gate that stops at any purchase or reservation step. Credential entry and transactional submit stay with the user.
- A private Docker Linux computer with bounded terminal commands, persistent workspace files, a text editor, PDF import/export, command receipts, and stop/restart recovery. Terminal networking is disabled.
- PDF viewing and supported form filling, reviewed Gmail/Calendar adapters, CSV spending artifacts, identity, and editable memory.

## Integration acceptance next

- [ ] Live Google OAuth, mail, attachment, and calendar acceptance on real test accounts.
- [ ] CopilotKit Intelligence Rich Threads persistence/replay and cross-device acceptance with a project key.
- [ ] Live model acceptance for open-ended delegated jobs and source-based research.
- [ ] Installed Android emulator/device smoke tests. Android bundles already export; iPhone simulator has been exercised.
- [ ] OpenBot user/session bridge, routines, and computer backend. The disabled HTTP adapter is contract-tested; it is not a live connection.

## Product extensions

- [ ] Interactive terminal sessions, per-person VM orchestration, controlled network access, and workspace disk quotas. The current [Linux computer](docs/COMPUTER.md) supports one owner per deployment.
- [x] Desktop applications. A Tauri control panel ships the implemented slices: a health-state contract with one state machine driving the tray, status page and notifications; start/stop/health/logs over `docker compose`; a prerequisite check with one-line fixes; a re-runnable setup wizard that writes `.env` in place behind a diff; and a system tray with OS notifications. Canonical state stays in `.env`, the Compose files and the API. Mobile QR pairing and approval notifications are not implemented; see [apps/desktop](apps/desktop/README.md).
- [ ] Customer-service flows and carefully scoped purchase handoff, built on the agent-operated browsing already shipped. Autonomous checkout, payment and reservation booking remain out of scope.
- [ ] Google Drive/Docs and individually validated social, bank, and health connectors.
- [ ] Device push notifications, voice input/replies, and image generation.
- [ ] OCR/scanned PDFs, more form types, and calendar recurrence editing.
- [ ] Adaptive long-term plans, broader source-backed ideas, and a managed registry for generated tools.
- [ ] Multi-user authentication, deployment hardening, retention/export controls, and operational recovery.

Each item needs its own authentication, capability boundaries, failure behavior, and end-to-end evidence before it becomes a supported feature. No dates or third-party API access are promised.
