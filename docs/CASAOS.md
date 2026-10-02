# CasaOS Manager

The agent can inspect your CasaOS server (apps, logs, system load) and — only after
you approve in the OpenMuse UI — start, stop or restart apps.

## Setup

1. Set `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64) and restart the API.
2. If CasaOS is not at the default `http://192.168.4.27`, set `CASAOS_API_URL`.
3. In the OpenMuse UI open **Connections → CasaOS** and enter your CasaOS username
   and password. A live login happens before anything is stored, so a wrong
   password is rejected immediately and never saved.
4. The agent's seven `casaos_*` tools appear once credentials are saved.

The credentials are encrypted with `TOKEN_ENCRYPTION_KEY` and stored at
`db.put(owner, "credentials", "casaos")`. This module does not intentionally
write them to `.env`, logs, error messages, API responses or tool results.
Deleting them
(**Connections → CasaOS → Disconnect**) also means pending reviews can no
longer be approved.

Note: the password travels from your device to the OpenMuse API when you save
it. Over a plain `http://` address it is unencrypted on your local network —
prefer the Tailscale HTTPS address when away from home.

## Behavior

- Read-only tools: `casaos_list_apps`, `casaos_app_status`, `casaos_app_logs`,
  `casaos_system_status`.
- Mutating tools: `casaos_start_app`, `casaos_stop_app`, `casaos_restart_app`.
  Each only *prepares* a review; the review expires after 30 minutes and
  executes only when you approve it in the UI. The CasaOS API applies the
  change asynchronously, so after executing the API waits ~3 seconds and polls
  the app list up to 3 times, then reports the actual observed status.
- If the outcome is ambiguous (CasaOS times out or returns 5xx), the review is
  marked `outcome_unknown` — no retries, no silent success. The agent asks you
  to check the app's status instead of assuming.
- Apps listed in `CASAOS_PROTECTED_APPS` (default `openmuse,tailscale,casaos`)
  can never be started, stopped or restarted — the request is rejected at
  proposal time and again at execution time.
- Logs are redacted (API keys, Bearer tokens, JWTs, URL credentials,
  `password=`-style assignments) and capped to an 8KB tail. App compose
  output never includes `environment` blocks.

## CasaOS address

`CASAOS_API_URL` defaults to `http://192.168.4.27`. If your router assigns a
different address via DHCP, update the variable and restart the API. From inside
the API container, `localhost` is the container itself — use the LAN address,
never `localhost`.

> **Heads-up:** the default URL is plain HTTP to a non-loopback host, which the
> transport policy below rejects unless you set `CASAOS_ALLOW_INSECURE_HTTP=true`
> (trusted LAN only — password and JWT travel in cleartext) or point the URL at
> an `https:` address. Without one of those, CasaOS stays disconnected with a
> 503 configuration error.

### Transport policy

Plain `http:` is only accepted for loopback hosts (`localhost`, `127.0.0.1`,
`::1`); any other `http:` address is rejected at request time with a
configuration error, because the CasaOS password and API token would travel
unencrypted. Two ways to comply:

- Point `CASAOS_API_URL` at an `https:` address (preferred when CasaOS and
  OpenMuse run on different machines), or
- Set `CASAOS_ALLOW_INSECURE_HTTP=true` — **only on a LAN you trust**. With
  this flag the password (at credential-save time) and the JWT (on every API
  call) travel in cleartext on your local network.

## Host verification

The dev sandbox cannot reach the CasaOS LAN, so these API shapes were verified
from the LAN itself by the operator on 2026-10-01 (login, appgrid, logs,
utilization). Only the first live mutation test below is still open.

Pre-release live checklist (run from the LAN host; the sandbox cannot reach it):

- [x] `net` field names in `/v1/sys/utilization` — **verified live 2026-10-01**:
      array of `{name, bytesSent, bytesRecv, ...}` cumulative counters
      (e.g. `eno1`). The system-status tool sums `bytesSent`→up / `bytesRecv`→down.
- [x] `?lines=N` support on `GET /v2/app_management/compose/{app}/logs` —
      **verified live 2026-10-01**: `?lines=5` returned exactly 5 lines,
      full log returned 334 lines.
- [x] `status` values in `GET /v2/app_management/web/appgrid` — **verified live
      2026-10-01**: `"running"`, `"exited"`, and one entry with no status key
      (mapped to `"unknown"` by the client).
- [ ] First live mutation test on the low-impact `handbrake` app: approve a stop,
      confirm exactly one PUT went out, confirm a second approval click does
      nothing, and confirm `openmuse` is rejected as protected. Enter the CasaOS
      password through the Tailscale HTTPS address, not plain
      `http://192.168.4.27:8081`.
