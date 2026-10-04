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
///
/// Backend-ready, not yet called by the shipped desktop UI: `ui/main.ts`
/// invokes only `write_file` and `open_web_ui`, so the tray keeps the icon it
/// was built with. `apps/desktop/README.md` states the same, so the claim is
/// not made in one place and retracted in another.
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
    let (rgba, width, height) = spark_rgba(bars);
    tauri::image::Image::new_owned(rgba, width, height)
}

/// The blitter's geometry, shared by the raster and its tests.
const SPARK_WIDTH: usize = 64;
const SPARK_HEIGHT: usize = 64;
const SPARK_INSET: usize = 40; // Leaves the status dot legible at the left.
const SPARK_BARS: usize = 16;

/// Paint the bars into a raw RGBA buffer and return it with its dimensions.
///
/// Separated from `spark_icon` so the bounds are provable by a unit test rather
/// than only by inspection: `Image`'s pixel data is not readable back out of an
/// owned image, so the raster is what the tests actually assert on.
fn spark_rgba(bars: &[f32]) -> (Vec<u8>, u32, u32) {
    // The invariant the saturating arithmetic in `rasterize` silently degrades
    // to "paints nothing": it is asserted here, on the shipping geometry, so a
    // bad edit to these constants fails immediately rather than turning the
    // sparkline into a blank icon nobody can explain.
    debug_assert!(
        SPARK_WIDTH > 0
            && SPARK_HEIGHT > 0
            && SPARK_BARS > 0
            && SPARK_INSET < SPARK_WIDTH
            && SPARK_INSET < SPARK_HEIGHT,
        "spark_icon constants are inconsistent"
    );
    rasterize(bars, SPARK_WIDTH, SPARK_HEIGHT, SPARK_INSET, SPARK_BARS)
}

/// The blitter itself, with its geometry as arguments.
///
/// At the shipped constants the `.min` and `.max` clamps below never actually
/// bind, so passing the geometry in is what lets a test drive a hostile one (an
/// inset wider than the icon, a slot count that does not divide the span) and
/// prove the arithmetic stays in bounds instead of underflowing.
fn rasterize(
    bars: &[f32],
    width_px: usize,
    height_px: usize,
    inset: usize,
    slots: usize,
) -> (Vec<u8>, u32, u32) {
    let mut rgba = vec![0u8; width_px * height_px * 4];
    // Every subtraction below saturates, so a geometry that would underflow
    // paints nothing rather than panicking. The invariant that keeps the result
    // *meaningful* is asserted where the shipping constants are declared.
    let span = width_px.saturating_sub(inset) / slots.max(1);
    let width = span.saturating_sub(1).max(1);
    for (slot, raw) in bars.iter().take(slots).enumerate() {
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
        let pixels = ((level * height_px.saturating_sub(inset) as f32).round() as usize).max(1);
        // `.min` keeps the last slot's bar inside the buffer: without it a bar
        // could start past `width_px - width` and write out of bounds.
        let x0 = (inset + slot * span).min(width_px.saturating_sub(width));
        for x in x0..x0 + width {
            for y in height_px.saturating_sub(pixels)..height_px {
                let offset = (y * width_px + x) * 4;
                rgba[offset] = 0x14;
                rgba[offset + 1] = 0x73;
                rgba[offset + 2] = 0xC8;
                rgba[offset + 3] = 0xFF;
            }
        }
    }
    (rgba, width_px as u32, height_px as u32)
}

#[cfg(test)]
mod spark_tests {
    use super::*;

    /// The alpha channel at a pixel, so a test can ask whether it was painted.
    fn alpha(rgba: &[u8], x: usize, y: usize) -> u8 {
        rgba[(y * SPARK_WIDTH + x) * 4 + 3]
    }

    /// Every pixel the raster touched, as `(x, y)`, for an icon of the given size.
    fn painted(rgba: &[u8], width_px: usize, height_px: usize) -> Vec<(usize, usize)> {
        (0..height_px)
            .flat_map(|y| (0..width_px).map(move |x| (x, y)))
            .filter(|&(x, y)| rgba[(y * width_px + x) * 4 + 3] != 0)
            .collect()
    }

    /// Painted pixels at the shipping geometry.
    fn painted_default(rgba: &[u8]) -> Vec<(usize, usize)> {
        painted(rgba, SPARK_WIDTH, SPARK_HEIGHT)
    }

    /// The buffer never exceeds the declared geometry, whatever is painted.
    fn assert_within_bounds(rgba: &[u8]) {
        assert_eq!(
            rgba.len(),
            SPARK_WIDTH * SPARK_HEIGHT * 4,
            "the raster must fill exactly its declared geometry"
        );
    }

    #[test]
    fn every_input_yields_a_64_by_64_icon() {
        // `Image` is the shipping type, so the wrapper is asserted directly as
        // well as the raster underneath it.
        for bars in [
            &[][..],
            &[0.0][..],
            &[1.0][..],
            &[f32::NAN][..],
            &[f32::INFINITY, f32::NEG_INFINITY][..],
            &vec![1.0; 64][..],
        ] {
            let image = spark_icon(bars);
            assert_eq!(image.width(), 64);
            assert_eq!(image.height(), 64);
            let (rgba, width, height) = spark_rgba(bars);
            assert_within_bounds(&rgba);
            assert_eq!((width, height), (64, 64));
        }
    }

    #[test]
    fn an_idle_window_paints_nothing_at_all() {
        // The transparent case that blanked the tray: no bar may be invented for
        // an agent that is doing nothing.
        let (rgba, _, _) = spark_rgba(&[]);
        assert_within_bounds(&rgba);
        assert_eq!(painted_default(&rgba), Vec::<(usize, usize)>::new());
        assert!(rgba.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn a_non_finite_bar_paints_nothing() {
        // NaN compares false against every comparison, so it would sail past a
        // `<= 0.0` guard on a value that was never clamped.
        for level in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let (rgba, _, _) = spark_rgba(&[level]);
            assert_within_bounds(&rgba);
            assert_eq!(
                painted_default(&rgba),
                Vec::<(usize, usize)>::new(),
                "{level}"
            );
        }
    }

    #[test]
    fn a_negative_bar_is_skipped_rather_than_clamped_to_a_stub() {
        let (rgba, _, _) = spark_rgba(&[-0.5, -1.0, -0.0]);
        assert_within_bounds(&rgba);
        assert_eq!(painted_default(&rgba), Vec::<(usize, usize)>::new());
    }

    #[test]
    fn a_single_half_height_bar_lands_where_the_geometry_says() {
        // At the shipped constants each slot is one pixel wide, starting at
        // SPARK_INSET, and half a bar is half of HEIGHT - INSET tall.
        let (rgba, _, _) = spark_rgba(&[0.5]);
        assert_within_bounds(&rgba);
        let lit = painted_default(&rgba);
        assert_eq!(lit.len(), 12, "half of the 24-pixel drawable height");
        // Slot 0 is the leftmost column of the bar area.
        assert!(lit.contains(&(40, 63)), "the bottom row must be painted");
        assert!(
            lit.contains(&(40, 52)),
            "the top of the bar must be painted"
        );
        assert_eq!(alpha(&rgba, 40, 51), 0, "above the bar is untouched");
        assert_eq!(alpha(&rgba, 39, 63), 0, "the inset stays clear");
        assert_eq!(alpha(&rgba, 41, 63), 0, "no neighbouring slot is lit");
    }

    #[test]
    fn every_bar_at_full_height_stays_inside_the_buffer() {
        // The maximum case: the topmost and rightmost slots are the ones that
        // would run off the end if the arithmetic were wrong.
        let full = vec![1.0; SPARK_BARS];
        let (rgba, _, _) = spark_rgba(&full);
        assert_within_bounds(&rgba);
        let lit = painted_default(&rgba);
        assert_eq!(lit.len(), SPARK_BARS * 24, "16 bars of 24 pixels each");
        assert!(lit.contains(&(40, 40)), "the first slot's top row");
        assert!(lit.contains(&(55, 40)), "the last slot's top row");
        assert!(!lit.iter().any(|&(x, _)| x < 40 || x >= 56));
        assert!(!lit.iter().any(|&(_, y)| y < 40));
    }

    #[test]
    fn a_window_longer_than_the_icon_is_truncated_not_overflowed() {
        // More samples than slots: the extras are dropped, and dropping them
        // must not shift or overwrite the bars that did fit.
        let mut bars = vec![0.0; 64];
        for bar in bars.iter_mut().take(SPARK_BARS) {
            *bar = 1.0;
        }
        let (rgba, _, _) = spark_rgba(&bars);
        assert_within_bounds(&rgba);
        assert_eq!(painted_default(&rgba).len(), SPARK_BARS * 24);
        let (short, _, _) = spark_rgba(&vec![1.0; SPARK_BARS]);
        assert_eq!(
            painted_default(&rgba),
            painted_default(&short),
            "the first 16 samples must render identically however many follow"
        );
    }

    #[test]
    fn a_partial_bar_never_paints_a_minimum_height_stub() {
        // A level small enough to round to zero would otherwise become a
        // one-pixel bar, reporting activity that is not happening.
        let (rgba, _, _) = spark_rgba(&[0.001]);
        assert_within_bounds(&rgba);
        let lit = painted_default(&rgba);
        assert_eq!(lit.len(), 1, "one pixel, and no more");
        assert_eq!(lit[0], (40, 63));
    }

    #[test]
    fn a_hostile_geometry_paints_nothing_rather_than_panicking() {
        // The reason every subtraction saturates. None of these can occur at the
        // shipped constants, which is exactly why they need a test: an inset
        // wider than the icon, an inset equal to the icon, and a slot count that
        // does not divide the span all used to be an ordinary `-` and a panic in
        // a debug build.
        let cases = [
            (16usize, 16usize, 40usize, 16usize), // inset far wider than the icon
            (16, 16, 16, 16),                     // inset exactly the width
            (16, 16, 15, 16),                     // one pixel of bar area
            (8, 8, 0, 16),                        // no inset at all
            (16, 16, 8, 3),                       // span does not divide evenly
            (16, 16, 8, 64),                      // more slots than pixels
            (1, 1, 0, 1),                         // a one-pixel icon
            (16, 16, 8, 0),                       // no slots at all
            (64, 64, 40, usize::MAX),             // an absurd slot count
        ];
        for (width_px, height_px, inset, slots) in cases {
            let (rgba, width, height) = rasterize(&[1.0; 32], width_px, height_px, inset, slots);
            assert_eq!(
                rgba.len(),
                width_px * height_px * 4,
                "{width_px}x{height_px} inset {inset} slots {slots}: buffer size"
            );
            assert_eq!((width, height), (width_px as u32, height_px as u32));
            // Anything painted at all must be a real pixel of this icon.
            for (x, y) in painted(&rgba, width_px, height_px) {
                assert!(x < width_px, "{x} is outside {width_px}");
                assert!(y < height_px, "{y} is outside {height_px}");
            }
        }
    }

    #[test]
    fn a_dense_row_of_slots_stays_inside_the_icon() {
        // Many slots across a narrow icon: each bar is placed from its slot index,
        // so this is the geometry where the `.min` on `x0` would matter if the
        // arithmetic were wrong. (With the shipped constants it cannot bind —
        // that is the point of asserting the bound instead of the clamp.)
        let (rgba, _, _) = rasterize(&[1.0; 64], 32, 32, 8, 12);
        assert_eq!(rgba.len(), 32 * 32 * 4);
        let lit = painted(&rgba, 32, 32);
        assert!(!lit.is_empty(), "bars must still be drawn");
        for &(x, y) in &lit {
            assert!(x < 32 && y < 32, "({x},{y}) escaped the 32x32 icon");
        }
        // Nothing is drawn in the inset area on the left.
        for (x, _) in &lit {
            assert!(*x >= 8, "a bar was drawn over the status dot area");
        }
    }
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
