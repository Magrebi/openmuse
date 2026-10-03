# Security policy

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** form for private reports. Include the affected commit, reproduction steps using fictional data, and the observed impact. Do not open a public issue containing credentials or a working exploit against someone else's deployment. This alpha has no guaranteed response time.

## Deployment boundary

OpenMuse currently supports one owner per deployment. Live mode uses a shared access key; it is not multi-tenant account authentication. Sample mode binds to loopback and contains fictional data. Use HTTPS and restricted network access for a remote live deployment.

The API holds provider credentials. Google tokens are encrypted at rest; short-lived signed URLs grant file and browser-console access. Protect `.env`, `.openmuse`, database backups, and browser profiles as private data. A signed URL is a credential until it expires.

The browser worker must remain private and require its own random token. It runs persistent Chromium with application-enforced public-network checks. Playwright disables Chromium's internal sandbox by default; this is not a full desktop VM or a security boundary for hostile tenants. The browser Docker image reduces host access but does not establish kernel-enforced network isolation. See [worker boundaries](apps/worker/README.md).

## Linux computer boundary

The optional computer service runs a **single-owner Docker Linux container**, separate from Chromium. It is disabled by default. The API launches only the fixed Docker CLI with argument arrays; user commands are passed to bash inside the container. It never falls back to a host shell. The API and its Docker connection are trusted infrastructure: protect them from other users and use an image you control.

The container runs as UID/GID 1000 with a read-only root filesystem, all capabilities dropped, no added privileges, and Docker networking set to `none`. It receives no host directory mounts, Docker socket, model keys, Google tokens, or API access key. Limits are 512 MB RAM with no swap, one CPU, 128 processes, and 64 MB of temporary storage. Existing containers and volumes must match this deployment's ownership labels and isolation settings before the service attaches.

A named volume persists `/workspace`. Commands may create, change, or delete its files. The file API stays inside `/workspace`, rejects symlink traversal and special files, and uses atomic text replacement. Text reads/writes are limited to 256 KB; PDF import/export is limited to 10 MB and checks ownership in OpenMuse. File contents and command output remain untrusted input for the agent.

Commands have a 30-second container timeout, a 2-second kill grace, a 35-second Docker-client timeout, and a combined 128 KB output cap. The server records output, status, and exit codes. Stop prevents restart until both Docker stop and the original execution are acknowledged. Failed cleanup retains a safety lock and permits an explicit Stop retry. Interrupted work is recorded with an uncertain outcome and is never automatically replayed.

Docker shares its host kernel and does not provide a full VM or a hostile-tenant guarantee. The persistent volume has no portable per-volume disk quota; provision and monitor Docker storage separately. The browser's public-web checks do not enable networking in the Linux computer. See [computer setup](docs/COMPUTER.md).

## External actions

A proposal is bound to the account, reviewed content, and applicable provider version. The server requires a recorded approval before dispatching a send or calendar change. An uncertain network outcome is retained for reconciliation. Cancellation stops later task steps; a provider request already in flight may still finish.

## Agent-driven browser input

A delegated model task may search, read and operate a web page. The server, not the model, enforces these limits: a 25-action budget per task that survives restart; a same-origin scope that freezes input when a page navigates elsewhere until the agent re-observes; and durable `browser_input` receipts recording each action, its parameters, and the URL before and after. Reading, searching and snapshotting are observations and do not spend the action budget.

Actions address elements by a short ref that `browser_snapshot` stamped onto the live document, which replaces guessing coordinates. A ref belongs to the document that issued it: after a navigation it no longer resolves, so a stale action is refused rather than applied to whatever now occupies that position. The worker accepts no caller-supplied selector or script, so an action can only ever name an element the snapshot itself offered.

The agent never types credentials. Credential-shaped text is refused before it reaches the page, a field the snapshot described as a password box is refused by name, and any sign-in page is handed back to the user through the takeover console. The worker repeats the password-field refusal at the point of action, so the rule still holds when the worker is reached without the server in front of it. A page that looks like a purchase, payment or reservation step pauses the task for the user; the agent does not add to a cart, check out, or submit a transaction. The credential heuristics are defence in depth, not a security boundary: the takeover console and the transactional gate are the real controls. An input whose outcome is unknown is recorded as uncertain, never replayed, and pauses further input until the page is read again. Page text is untrusted data and cannot grant a permission or approve an action.

Web search runs inside the worker's own browser and is subject to the same public-URL, DNS and egress checks as any navigation. A result that is not a public HTTP(S) address is dropped rather than handed to the agent as an address to open.

Waiting, searching, snapshotting and switching tabs are observations: they change nothing on the page and spend no part of the action budget. A wait takes a fixed verb or a ref, never a selector, so it cannot become a way to poll the page indefinitely. A session holds a bounded number of tabs; a page that opens its own window is closed rather than adopted, so a site cannot spawn an extra browsing context the user never asked for.

Uploading names a file rather than carrying it. The worker resolves the name inside the session's own folder, so bytes never travel in a request and an upload can only offer a file the owner already stored. A plain base name is required — separators, traversal and absolute paths are refused — and the size is capped. Because an upload sends data off the machine, it is refused on a sign-in page, where a form is most likely to ask for a document.

A server-only CopilotKit Intelligence project key is needed for the sample walkthrough. CI uses synthetic keys and mocked Intelligence boundaries. No provider keys, personal data, or third-party logins are needed for CI. CopilotKit Intelligence and any configured model/provider operate under their own terms and data policies. Optional live Jev (`JEV_MODE=live`) sends the user's latest message, agent-written context, and candidate choices to TypeSafe; see [what live mode sends](docs/demos/jev-generative-ui.md#what-live-mode-sends-to-typesafe).
