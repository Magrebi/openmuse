# Changelog

## Unreleased

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
