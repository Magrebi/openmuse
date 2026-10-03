//! The subprocess boundary. Every command is an argv array: this module is the
//! only place a process is created, and it never builds a shell string, so a
//! value from `.env` cannot become shell syntax.

use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The only programs this app may execute. A caller cannot supply a program
/// name: the service table in the TypeScript core selects one of these.
pub const ALLOWED_PROGRAMS: [&str; 2] = ["docker", "pnpm"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: String,
}

impl CommandSpec {
    fn validate(&self) -> Result<(), String> {
        if !ALLOWED_PROGRAMS.contains(&self.program.as_str()) {
            return Err(format!("refusing to run {}", self.program));
        }
        if self.args.is_empty() {
            return Err("command has no arguments".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Run a command to completion and capture its output.
pub fn run(spec: &CommandSpec, timeout: Duration) -> Result<ProcessResult, String> {
    spec.validate()?;
    let mut child = Command::new(&spec.program)
        .args(&spec.args)
        .current_dir(&spec.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("could not start {}: {}", spec.program, error))?;

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Ok(ProcessResult {
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    timed_out: true,
                });
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(80)),
            Err(error) => return Err(format!("could not wait for {}: {}", spec.program, error)),
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|error| format!("could not read output: {}", error))?;
    Ok(ProcessResult {
        exit_code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        timed_out: false,
    })
}

/// A long-lived child such as `docker compose logs -f` or a host-mode service.
///
/// Its output is streamed to `on_line` as untrusted text. Nothing in that text
/// is ever interpreted, and `stop` signals this exact child — never a name or a
/// pattern, so it cannot reach a process the app did not start.
pub struct Handle {
    child: Arc<Mutex<Option<Child>>>,
}

impl Handle {
    pub fn spawn(
        spec: &CommandSpec,
        on_line: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<Self, String> {
        spec.validate()?;
        let child = Command::new(&spec.program)
            .args(&spec.args)
            .current_dir(&spec.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not start {}: {}", spec.program, error))?;

        let slot = Arc::new(Mutex::new(Some(child)));
        // stdout and stderr are distinct types, so each gets its own reader
        // rather than being collected into one array.
        let (out, err) = {
            let mut guard = slot.lock().unwrap();
            let child = guard.as_mut().ok_or("child already reaped")?;
            (child.stdout.take(), child.stderr.take())
        };
        let reader: Arc<dyn Fn(String) + Send + Sync> = Arc::from(on_line);
        if let Some(out) = out {
            let on_line = Arc::clone(&reader);
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    on_line(line);
                }
            });
        }
        if let Some(err) = err {
            let on_line = Arc::clone(&reader);
            std::thread::spawn(move || {
                use std::io::{BufRead, BufReader};
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    on_line(line);
                }
            });
        }

        // Reap the child in the background so it never becomes a zombie.
        let reaper = Arc::clone(&slot);
        std::thread::spawn(move || {
            if let Some(mut child) = reaper.lock().unwrap().take() {
                let _ = child.wait();
            }
        });

        Ok(Handle { child: slot })
    }

    /// Ask this child to stop.
    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Resolve `candidate` inside `root`, refusing anything that escapes.
///
/// Checked without touching the disk, so a `../` escape, an absolute path
/// elsewhere, or a sibling directory sharing the repo's name prefix is rejected
/// before any subprocess or file write happens.
pub fn resolve_in_repo(root: &Path, candidate: &str) -> Result<PathBuf, String> {
    let mut resolved = root.to_path_buf();
    for component in Path::new(candidate).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                // `pop` returns whether it removed anything; a `..` that would
                // climb above the root fails the containment check below.
                let popped = resolved.pop();
                if !popped || !resolved.starts_with(root) {
                    return Err(format!("path is outside the repository: {}", candidate));
                }
            }
            _ => return Err(format!("path is outside the repository: {}", candidate)),
        }
    }
    if !resolved.starts_with(root) {
        return Err(format!("path is outside the repository: {}", candidate));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_traversal_escape_is_rejected() {
        let root = Path::new("/repo");
        for attempt in [
            "../.env",
            "../../etc/passwd",
            "infra/../../secrets",
            "/etc/passwd",
        ] {
            assert!(resolve_in_repo(root, attempt).is_err(), "{}", attempt);
        }
    }

    #[test]
    fn a_sibling_sharing_the_prefix_is_outside() {
        let root = Path::new("/repo/openmuse");
        assert!(resolve_in_repo(root, "/repo/openmuse-backup/.env").is_err());
        assert_eq!(
            resolve_in_repo(root, "infra/compose.yaml").unwrap(),
            PathBuf::from("/repo/openmuse/infra/compose.yaml")
        );
    }

    #[test]
    fn only_docker_and_pnpm_may_run() {
        let shell = CommandSpec {
            program: "sh".into(),
            args: vec!["-c".into(), "echo hi".into()],
            cwd: "/repo".into(),
        };
        assert!(shell.validate().is_err());
        let empty = CommandSpec {
            program: "docker".into(),
            args: vec![],
            cwd: "/repo".into(),
        };
        assert!(empty.validate().is_err());
    }
}
