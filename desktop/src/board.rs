//! Where the board lives: the Node daemon, its data folder, and the settings the MCP reads.

use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const DEFAULT_PORT: u16 = 4747;

pub fn port() -> u16 {
    std::env::var("SCRIBE_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// Whether something answers on the board port. Quick enough to ask on the UI's behalf.
pub fn is_running() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], port()));
    TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_ok()
}

/// The Scribe folder whose `dist/index.js` runs the daemon: `SCRIBE_DIR`, else the `app` folder a release
/// installer puts beside this exe (`npm run desktop:release`), else the clone this app was built from.
fn repo_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("SCRIBE_DIR") {
        return PathBuf::from(dir);
    }
    bundled_dir().unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."))
}

fn bundled_dir() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("app");
    dir.join("dist").join("index.js").is_file().then_some(dir)
}

/// The Node a release ships in `app/node`, else the one on PATH.
fn node(dir: &std::path::Path) -> PathBuf {
    let bundled = dir.join("node").join(if cfg!(windows) { "node.exe" } else { "node" });
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("node")
    }
}

/// Same folder as `dataDir()` in src/config.ts.
pub fn data_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("SCRIBE_HOME") {
        return PathBuf::from(home);
    }
    let root = std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    root.join("scribe")
}

/// Starts the daemon, or replaces one from another build, through the same code path the MCP uses.
pub fn ensure_daemon() -> Result<(), String> {
    let dir = repo_dir();
    let script = dir.join("dist").join("index.js");
    if !script.is_file() {
        return Err(format!(
            "{} is missing. Run npm install and npm run build in the Scribe folder, or set SCRIBE_DIR.",
            script.display()
        ));
    }
    let mut command = Command::new(node(&dir));
    command.arg(&script).arg("--ensure");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|err| format!("Could not run node: {err}. Install Node.js 22.13 or newer and put it on PATH."))?;
    if output.status.success() {
        return Ok(());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    Err(format!("The board daemon did not start.\n\n{}", detail.trim()))
}

/// `desktop.json` in the data folder tells the MCP to open this app instead of a browser tab.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub exe: String,
    #[serde(default = "yes")]
    pub open_from_agents: bool,
}

fn yes() -> bool {
    true
}

fn registration_path() -> PathBuf {
    data_dir().join("desktop.json")
}

pub fn read_registration() -> Option<Registration> {
    let text = std::fs::read_to_string(registration_path()).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_registration(open_from_agents: bool) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let registration = Registration {
        exe: exe.to_string_lossy().into_owned(),
        open_from_agents,
    };
    let _ = std::fs::create_dir_all(data_dir());
    if let Ok(text) = serde_json::to_string_pretty(&registration) {
        let _ = std::fs::write(registration_path(), text);
    }
}

/// `--open <board url>` from the MCP, reduced to the tab id or key after `#`.
pub fn tab_from_args(args: &[String]) -> Option<String> {
    let at = args.iter().position(|arg| arg == "--open")?;
    let url = args.get(at + 1)?;
    let (_, hash) = url.split_once('#')?;
    let valid = !hash.is_empty()
        && hash.len() <= 200
        && hash.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:".contains(c));
    valid.then(|| hash.to_string())
}

/// Opens a link from a page in the system browser. Only web and mail links.
pub fn open_external(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")) {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(url).spawn();
    }
}
