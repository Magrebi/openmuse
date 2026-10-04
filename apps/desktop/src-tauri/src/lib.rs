//! The native host. It owns the effects the TypeScript core cannot perform:
//! spawning `docker` and `pnpm`, reading and writing `.env` inside the repo, the
//! OS keychain, the tray, and notifications.
//!
//! Everything the user sees is rendered from one deployment state machine in
//! `../src/state.ts`; this layer never keeps a second copy of that state.

mod proc;

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_notification::NotificationExt;

const KEYCHAIN_SERVICE: &str = "ai.copilotkit.openmuse";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPaths {
    /// Absolute repository root. Every file operation is confined to it.
    pub root: String,
    pub compose_file: String,
    pub env_file: String,
}

impl RepoPaths {
    /// Resolve a repo-relative path, refusing anything that escapes.
    fn resolve(&self, candidate: &str) -> std::result::Result<PathBuf, String> {
        proc::resolve_in_repo(&PathBuf::from(&self.root), candidate)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopError {
    pub code: String,
    pub message: String,
    /// One line the person can act on. Never a stack trace.
    pub fix: Option<String>,
}

impl DesktopError {
    fn new(code: &str, message: impl Into<String>, fix: Option<&str>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            fix: fix.map(str::to_string),
        }
    }
}

type Result<T> = std::result::Result<T, DesktopError>;

/// One prerequisite line. `fix` is present only when the check failed, and is
/// always a single sentence a person can act on.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub id: String,
    pub label: String,
    pub ok: bool,
    pub fix: Option<String>,
}

impl CheckResult {
    fn new(id: &str, label: &str, ok: bool, fix: Option<&str>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ok,
            // No fix line for a passing check; the UI shows "ready".
            fix: if ok { None } else { fix.map(str::to_string) },
        }
    }
}

#[derive(Default)]
struct AppState {
    /// Secrets registered by the core, stripped from every captured line.
    secrets: Vec<String>,
    children: HashMap<String, proc::Handle>,
}

fn outside<E: std::fmt::Display>(error: E) -> DesktopError {
    DesktopError::new(
        "PATH_OUTSIDE_REPO",
        error.to_string(),
        Some("Choose a file inside the OpenMuse folder."),
    )
}

#[tauri::command]
fn run_command(
    paths: RepoPaths,
    program: String,
    args: Vec<String>,
    timeout_ms: Option<u64>,
) -> Result<proc::ProcessResult> {
    let spec = proc::CommandSpec {
        program,
        args,
        // The command always runs inside the repo, whatever the caller asked for.
        cwd: paths.root.clone(),
    };
    proc::run(&spec, Duration::from_millis(timeout_ms.unwrap_or(600_000))).map_err(|error| {
        DesktopError::new(
            "COMPOSE_FAILED",
            error,
            Some("Open the Logs tab for details."),
        )
    })
}

/// The launch check, in the order a person would fix it. Mirrors
/// `checkPrerequisites` in the core: Docker CLI, daemon, compose plugin, the
/// `.env` file, then the three ports. Each failure carries one actionable line.
#[tauri::command]
fn prerequisites(paths: RepoPaths) -> Result<Vec<CheckResult>> {
    let run = |args: &[&str]| -> bool {
        Command::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    };
    let cli = Command::new("docker").arg("--version").output().is_ok();
    let mut results = vec![CheckResult::new(
        "docker-cli",
        "Docker",
        cli,
        Some("Install Docker Desktop, then reopen the OpenMuse app."),
    )];
    if cli {
        results.push(CheckResult::new(
            "docker-daemon",
            "Docker is running",
            run(&["info"]),
            Some("Start Docker Desktop and try again."),
        ));
        results.push(CheckResult::new(
            "compose-plugin",
            "Docker Compose",
            run(&["compose", "version"]),
            Some("Update Docker Desktop to include Docker Compose."),
        ));
    }
    let env = paths
        .resolve(&paths.env_file)
        .map(|path| path.exists())
        .unwrap_or(false);
    results.push(CheckResult::new(
        "env-file",
        "Configuration file",
        env,
        Some("Run the Setup wizard to create the .env file."),
    ));
    for (id, label, port) in [
        ("api-port", "API port", 8787u16),
        ("web-port", "Web port", 8081),
        ("worker-port", "Browser worker port", 8790),
    ] {
        results.push(CheckResult::new(
            id,
            &format!("{} {}", label, port),
            !port_in_use(port),
            Some(&format!(
                "Port {} is already in use. Stop the other program, or stop that OpenMuse.",
                port
            )),
        ));
    }
    Ok(results)
}

/// Start a long-lived child such as `docker compose logs -f`, streaming each
/// line to the webview after redacting the registered secrets.
#[tauri::command]
fn spawn_logged(
    app: AppHandle,
    state: tauri::State<'_, Mutex<AppState>>,
    paths: RepoPaths,
    name: String,
    program: String,
    args: Vec<String>,
) -> Result<()> {
    let spec = proc::CommandSpec {
        program,
        args,
        cwd: paths.root.clone(),
    };
    let app_for_lines = app.clone();
    let guard = state.lock().unwrap();
    let secrets = guard.secrets.clone();
    drop(guard);
    let service = name.clone();
    let handle = proc::Handle::spawn(
        &spec,
        Box::new(move |line: String| {
            // Redact before the line ever reaches the UI, never after.
            let mut safe = line;
            for secret in secrets.iter().filter(|value| value.len() >= 8) {
                safe = safe.replace(secret.as_str(), "[redacted]");
            }
            let _ = app_for_lines.emit(
                "openmuse://log",
                serde_json::json!({ "service": service, "line": safe }),
            );
        }),
    )
    .map_err(|error| {
        DesktopError::new(
            "COMPOSE_FAILED",
            error,
            Some("Open the Logs tab for details."),
        )
    })?;
    state.lock().unwrap().children.insert(name, handle);
    Ok(())
}

/// Signal every long-lived child (a running service or a `logs -f` stream).
/// Each is the exact process this app started, never a name or a pattern.
#[tauri::command]
fn stop_children(state: tauri::State<'_, Mutex<AppState>>) -> Result<()> {
    // Drained into a local Vec first, so the app-wide mutex is released before
    // any child is stopped: `Handle::stop` waits on the child's exit, and holding
    // the lock across that would stall every other command needing the state.
    let handles: Vec<proc::Handle> = state
        .lock()
        .unwrap()
        .children
        .drain()
        .map(|(_, handle)| handle)
        .collect();
    for handle in handles {
        handle.stop();
    }
    Ok(())
}

#[tauri::command]
fn read_file(paths: RepoPaths, relative: String) -> Result<String> {
    let path = paths.resolve(&relative).map_err(outside)?;
    std::fs::read_to_string(&path)
        .map_err(|error| DesktopError::new("ENV_INVALID", error.to_string(), None))
}

#[tauri::command]
fn write_file(paths: RepoPaths, relative: String, contents: String) -> Result<()> {
    // Only the canonical state files may be written through this surface.
    if !matches!(
        relative.as_str(),
        ".env" | ".env.example" | "infra/compose.yaml"
    ) {
        return Err(DesktopError::new(
            "PATH_OUTSIDE_REPO",
            format!("The desktop app does not edit {}", relative),
            Some("Editable files: .env, .env.example, infra/compose.yaml."),
        ));
    }
    let path = paths.resolve(&relative).map_err(outside)?;
    std::fs::write(&path, contents)
        .map_err(|error| DesktopError::new("ENV_INVALID", error.to_string(), None))
}

#[tauri::command]
fn copy_file(paths: RepoPaths, from: String, to: String) -> Result<()> {
    let source = paths.resolve(&from).map_err(outside)?;
    let target = paths.resolve(&to).map_err(outside)?;
    std::fs::copy(&source, &target).map_err(|error| {
        DesktopError::new(
            "ENV_BACKUP_FAILED",
            error.to_string(),
            Some("Close any editor holding the file, then try again."),
        )
    })?;
    Ok(())
}

#[tauri::command]
fn file_exists(paths: RepoPaths, relative: String) -> Result<bool> {
    Ok(paths.resolve(&relative).map_err(outside)?.exists())
}

/// Store a value in the OS keychain, so the access key is not kept in app
/// settings on disk. `.env` remains the file the deployment itself reads.
#[tauri::command]
fn keychain_set(key: String, value: String) -> Result<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|error| DesktopError::new("ENV_INVALID", error.to_string(), None))?;
    entry
        .set_password(&value)
        .map_err(|error| DesktopError::new("ENV_INVALID", error.to_string(), None))
}

#[tauri::command]
fn keychain_get(key: String) -> Result<Option<String>> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, &key)
        .map_err(|error| DesktopError::new("ENV_INVALID", error.to_string(), None))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(DesktopError::new("ENV_INVALID", error.to_string(), None)),
    }
}

/// Whether a TCP port is already bound on loopback.
#[tauri::command]
fn port_in_use(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_err()
}

/// Point the window at the local web UI. Loopback only, checked before the
/// navigation, so the app can never be steered to a remote origin.
#[tauri::command]
fn open_web_ui(app: AppHandle, url: String) -> Result<()> {
    if !url.starts_with("http://127.0.0.1") && !url.starts_with("http://localhost") {
        return Err(DesktopError::new(
            "HEALTH_INVALID",
            format!("refusing to open {}", url),
            Some("The desktop app only opens OpenMuse on this computer."),
        ));
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| DesktopError::new("UNSUPPORTED", "window not found", None))?;
    let target = url.parse().map_err(|_| {
        DesktopError::new(
            "HEALTH_INVALID",
            "invalid URL",
            Some("Use the local OpenMuse address."),
        )
    })?;
    window
        .navigate(target)
        .map_err(|error| DesktopError::new("UNSUPPORTED", error.to_string(), None))?;
    Ok(())
}

/// Accept secrets so they can be stripped from captured output.
#[tauri::command]
fn register_secrets(state: tauri::State<'_, Mutex<AppState>>, secrets: Vec<String>) {
    let mut guard = state.lock().unwrap();
    guard.secrets = secrets
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect();
}

/// Replace the known secrets in a line of untrusted process output. The
/// core redacts too; doing it here means nothing reaches a log viewer raw.
#[tauri::command]
fn redact_line(state: tauri::State<'_, Mutex<AppState>>, line: String) -> String {
    let guard = state.lock().unwrap();
    let mut output = line;
    for secret in guard.secrets.iter().filter(|value| value.len() >= 8) {
        output = output.replace(secret.as_str(), "[redacted]");
    }
    output
}

/// Forward an already-redacted log line to the webview. The text is untrusted
/// and is only ever displayed, never interpreted.
#[tauri::command]
fn emit_log(app: AppHandle, service: String, line: String) {
    let _ = app.emit(
        "openmuse://log",
        serde_json::json!({ "service": service, "line": line }),
    );
}

/// Push the state machine's tone into the tray and, for a transition worth
/// interrupting for, an OS notification.
///
/// `spark` is a short list of bar heights in `0.0..=1.0`, oldest first, already
/// scaled by the TypeScript core. It arrives as a list rather than a bitmap so
/// that every decision about what the bars mean stays in code that is unit
/// tested; this layer only blits. An absent or empty list means the agent is
/// idle, and the plain icon is correct — drawing minimum-height stubs would
/// report activity that is not happening.
#[tauri::command]
fn announce(
    app: AppHandle,
    tone: String,
    state: String,
    notify: Option<String>,
    spark: Option<Vec<f32>>,
) -> Result<()> {
    set_tray(&app, &tone, &state, spark.as_deref());
    if let Some(body) = notify {
        let _ = app
            .notification()
            .builder()
            .title("OpenMuse")
            .body(body)
            .show();
    }
    Ok(())
}

fn set_tray(app: &AppHandle, tone: &str, state: &str, spark: Option<&[f32]>) {
    let Some(tray) = app.tray_by_id("openmuse") else {
        return;
    };
    // The tooltip carries both the state and its tone, so the tray colour and
    // the status page can never disagree about which state this is.
    let _ = tray.set_tooltip(Some(format!("OpenMuse — {} ({})", state, tone)));
    if let Some(bars) = spark {
        // An idle window must not blank the tray. `spark_icon(&[])` is a fully
        // transparent 64x64 buffer, which a menu bar renders as no icon at all,
        // and `set_icon(None)` *removes* the icon rather than restoring the
        // default one — so the app's own icon goes back, which is the plain icon
        // the idle state is documented to show.
        let icon = if bars.is_empty() {
            app.default_window_icon().cloned()
        } else {
            Some(spark_icon(bars))
        };
        let _ = tray.set_icon(icon);
    }
}

/// Bars in `0.0..=1.0` become a row of columns, oldest on the left.
///
/// Values are clamped rather than trusted: they cross a process boundary from a
/// webview, and an unclamped height would index outside the pixel buffer.
/// Non-finite values are treated as zero for the same reason — a NaN reaching
/// the cast below would become an arbitrary address.
fn spark_icon(bars: &[f32]) -> tauri::image::Image<'static> {
    const WIDTH: usize = 64;
    const HEIGHT: usize = 64;
    const INSET: usize = 40; // Leaves the status dot legible at the left.
    const BARS: usize = 16;
    // The geometry below is written in saturating arithmetic on the assumption
    // that these four constants are sane. If they are ever edited into an
    // unsound combination, that must fail loudly here rather than silently
    // painting nothing or writing past the buffer.
    debug_assert!(
        WIDTH > 0 && HEIGHT > 0 && BARS > 0 && INSET < WIDTH && INSET < HEIGHT,
        "spark_icon constants are inconsistent"
    );
    let mut rgba = vec![0u8; WIDTH * HEIGHT * 4];
    // Derived once, and with saturating arithmetic: at these constants the slot
    // width is 1, so an ordinary `- 2` for the gap would underflow and panic.
    let span = WIDTH.saturating_sub(INSET) / BARS;
    let width = span.saturating_sub(1).max(1);
    for (slot, raw) in bars.iter().take(BARS).enumerate() {
        // NaN compares false against everything, so `is_finite` is what keeps a
        // non-finite value from reaching the cast below as an arbitrary address.
        let level = if raw.is_finite() {
            raw.clamp(0.0, 1.0)
        } else {
            0.0
        };
        // A bar with no height is no bar. The TypeScript core already omits idle
        // samples, so reaching zero here means a malformed or hand-built call —
        // and painting a one-pixel stub for it would report activity that is
        // not happening, which is the one thing the sparkline must never do.
        if level <= 0.0 {
            continue;
        }
        let pixels = ((level * HEIGHT.saturating_sub(INSET) as f32).round() as usize).max(1);
        // `.min` keeps the last slot's bar inside the buffer: without it a bar
        // could start past `WIDTH - width` and write out of bounds.
        let x0 = (INSET + slot * span).min(WIDTH.saturating_sub(width));
        for x in x0..x0 + width {
            for y in HEIGHT.saturating_sub(pixels)..HEIGHT {
                let offset = (y * WIDTH + x) * 4;
                rgba[offset] = 0x14;
                rgba[offset + 1] = 0x73;
                rgba[offset + 2] = 0xC8;
                rgba[offset + 3] = 0xFF;
            }
        }
    }
    tauri::image::Image::new_owned(rgba, WIDTH as u32, HEIGHT as u32)
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open OpenMuse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let mut builder = TrayIconBuilder::with_id("openmuse")
        .menu(&menu)
        .tooltip("OpenMuse — stopped");
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => focus_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                focus_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn focus_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            focus_main(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(AppState::default()))
        .invoke_handler(tauri::generate_handler![
            run_command,
            spawn_logged,
            stop_children,
            read_file,
            write_file,
            copy_file,
            file_exists,
            keychain_set,
            keychain_get,
            port_in_use,
            prerequisites,
            open_web_ui,
            register_secrets,
            redact_line,
            emit_log,
            announce,
        ])
        .setup(|app| build_tray(&app.handle()).map_err(|error| error.into()))
        .build(tauri::generate_context!())
        .expect("error while building OpenMuse")
        .run(|app, event| {
            // Exiting signals every child this app started, so no service is
            // left orphaned and no name-matched kill can reach someone else's.
            if let RunEvent::ExitRequested { .. } = event {
                // Same shape as `stop_children`: the children are taken out
                // under the lock, and the waits happen with it released.
                let handles: Vec<proc::Handle> = app
                    .state::<Mutex<AppState>>()
                    .lock()
                    .unwrap()
                    .children
                    .drain()
                    .map(|(_, handle)| handle)
                    .collect();
                for handle in handles {
                    handle.stop();
                }
            }
        });
}
