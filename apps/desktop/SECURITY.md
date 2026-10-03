# Desktop app security boundary

The desktop app is a control surface over an existing deployment. It starts and
stops processes, edits one configuration file, and shows status. This document
states what that means if the machine is compromised, so the boundary is not
mistaken for a sandbox.

## Trust model

**Trusted:** the user running the app, the OpenMuse repository they point it at,
and the OS.

**Untrusted:** everything else — container output, log lines, `.env` values the
user pasted, and the content of any page the agent reads. Untrusted text is
displayed and never executed, interpreted, or used to build a command.

## What the app will not do

- **No shell.** Every subprocess is an argv array. There is no `sh -c`, no
  string concatenation into a command line, and no interpolation of a value
  from `.env` into a command. `src-tauri/src/proc.rs` is the only place a
  process is created, and it rejects any program other than `docker` or `pnpm`.
- **No path escape.** Every file path is resolved inside the repository before
  use. A `../` traversal, an absolute path elsewhere, or a sibling directory
  sharing the repo's name prefix is rejected before any read or write. Only
  `.env`, `.env.example` and `infra/compose.yaml` are writable.
- **No accidental data loss.** `docker compose down` is issued without `-v` and
  there is no command, button, or flag in this app that removes volumes.
- **No weakened authentication.** The app never injects the access key into a
  page, never stores it outside the OS keychain and `.env`, and offers no
  "remember me" path. Sign-in stays in the web UI, unchanged.
- **No network listener.** It binds nothing and refuses to open a URL that is
  not loopback. Health checks and the webview both go to `127.0.0.1`.
- **No new approval path.** A send, purchase or calendar change still requires
  the web UI's review card. This app cannot approve anything on its own.

## Secrets

`OPENMUSE_ACCESS_KEY`, `TOKEN_ENCRYPTION_KEY`, `WORKER_TOKEN`, provider keys and
`CPK_INTELLIGENCE_API_KEY` are treated as secrets:

- Generated with the OS CSPRNG, never a weak random source.
- Written only into `.env`, which the owner already holds, and into the OS
  keychain when the app needs to remember one.
- Redacted out of captured process output before it reaches the log viewer.
  Compose echoes its resolved environment on some failures, so redaction runs
  on every captured chunk and also masks `KEY=value` pairs.
- Shown at most once, at the moment they are generated, so they can be copied.

`.env` is a plaintext file on the user's own disk. Anyone who can read that file
can read the secrets; this app does not change that and does not pretend to.

## If the machine is compromised

Assume the attacker already runs code as the user. Then:

- **They can read `.env` and the keychain.** The secrets are obtainable. Any
  data OpenMuse can reach — the sample workspace, a live Google account, model
  provider calls — is reachable through them. Rotating `OPENMUSE_ACCESS_KEY`
  and `WORKER_TOKEN` in `.env` and restarting invalidates them.
- **They can run `docker` and `pnpm`.** The app restricts itself, not the user.
  Docker access on this machine is effectively root-equivalent for the Linux
  containers it runs, which is why the browser worker drops all capabilities and
  the OpenMuse control panel adds no privileged container of its own.
- **They can read or edit `.env`.** Canonical state is a plaintext file by
  design, so this app adds no new protection there. It does show a diff before
  writing, which helps honest mistakes, not a determined attacker.
- **They can read the agent's traffic and page content.** The app adds no
  encryption of its own and no new egress path.

What the app *does* limit is the damage a bug or a tampered `.env` can do on its
own: no shell injection, no writes outside the repository, no volume deletion,
and no secret leaking into a log line.

## Out of scope

This app is not hardened against a local attacker, and it is not a security
boundary for the deployment itself. The web API, its single-owner access model,
and the review cards remain the real controls. See the repository
[SECURITY.md](../../SECURITY.md) for those.

## Reporting

Report a vulnerability through the process in the repository
[SECURITY.md](../../SECURITY.md). Do not include `.env`, keys, or personal data
in a report.
