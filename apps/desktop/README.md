# OpenMuse desktop app

A control panel for a local OpenMuse deployment, so the stack can be started,
stopped and watched without opening a terminal.

The web app is still where the work happens. This app manages the deployment
around it and then opens `http://127.0.0.1:8081` in a webview.

## What it does

- **One state machine.** `src/state.ts` is the single source of truth:
  `unknown → stopped → starting → healthy | degraded | error → stopping`. The
  tray icon, the status page and the OS notifications all render from it, and
  transitions are driven only by Compose exit codes and `GET /api/health`.
- **Start and stop.** Runs `docker compose … up -d` and `… down`. `down` never
  passes `-v`, so volumes — the saved browser profiles and downloads — always
  survive a stop and restart. There is no UI path that can delete them.
- **Prerequisites on launch.** Docker reachable, `docker compose` present,
  ports 8787 / 8081 / 8790 free, and `.env` present. Each failure shows one
  actionable line ("Start Docker Desktop", "Port 8081 is already in use…").
- **Logs.** `docker compose logs -f` per service, with a tab for API, web and
  browser worker. Output is treated as untrusted text: it is redacted and
  displayed, never executed or interpreted.
- **Setup wizard.** Generates missing secrets, writes `MODEL` and a provider
  key, and shows a diff before anything is saved. Re-runnable.
- **Tray and notifications.** Grey when stopped, amber while starting or
  degraded, green when healthy, red on error.

## What it does not do

- It is not a second configuration store. Canonical state stays in `.env`, the
  Compose files and the API. If a value can be configured, this app edits
  `.env` in place and shows the change first.
- It does not change authentication. Single owner plus
  `OPENMUSE_ACCESS_KEY`, signed in through the web app's own sign-in card. The
  key is never injected into a page.
- It adds no approval path. Sends, purchases and calendar changes are still
  reviewed in the web UI.
- It is not a fleet manager: one machine, one deployment, no remote control,
  and no auto-update.

## Install

Requires Node 24 LTS, pnpm 11.19.0, Docker Desktop, and a Rust toolchain
(`rustup`) to build from source. Prebuilt binaries are attached to releases.

```sh
pnpm install --frozen-lockfile
pnpm --dir apps/desktop build   # compiles the UI into dist/
```

## Run

```sh
pnpm tauri:dev     # development, with hot reload of the control panel
pnpm tauri:build   # a signed installer for the current platform
```

The app expects to find the OpenMuse repository. Point it at your clone on
first launch.

## First run

1. Launch the app. The prerequisite check runs immediately.
2. If `.env` is missing, open **Setup wizard**. It generates
   `OPENMUSE_ACCESS_KEY`, `TOKEN_ENCRYPTION_KEY` and `WORKER_TOKEN` with the
   OS crypto RNG, and shows your access key once so you can copy it.
3. Paste a model provider key and your CopilotKit Intelligence key
   (`npx copilotkit@latest login`). Both land in `.env`.
4. Review the diff, save, then press **Start**.

Running the wizard again repairs a broken `.env`. It preserves any secret that
is already valid unless you explicitly ask to regenerate that one key, and an
existing `.env` is always copied to a timestamped backup first.

## Development

```sh
pnpm --dir apps/desktop test       # state machine, subprocess, wizard, .env
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop icons      # regenerate the tray and bundle icons
cd apps/desktop/src-tauri && cargo test
```

The layout follows the existing workspace conventions: the deployment logic is
TypeScript under `src/` and tested with `node:test`, and the native layer is a
thin Rust host that only performs effects.

## Security

See [SECURITY.md](SECURITY.md) for the threat boundary: what this app can and
cannot do if the machine is compromised.
