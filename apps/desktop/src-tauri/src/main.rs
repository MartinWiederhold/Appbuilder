#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, process::Stdio};
use tauri::{Emitter, Window};

fn repo_root() -> PathBuf {
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // .../apps/desktop/src-tauri
  let desktop = manifest.parent().unwrap();                 // .../apps/desktop
  let apps = desktop.parent().unwrap();                     // .../apps
  apps.parent().unwrap().to_path_buf()                      // repo root
}

#[derive(serde::Serialize)]
struct ProjectInfo {
  name: String,
  last_status: String,        // "success" | "failed" | "never"
  finished_at: Option<String> // ISO timestamp
}

#[tauri::command]
fn list_projects_with_status() -> Vec<ProjectInfo> {
  let root = repo_root().join("workspace/projects");
  let mut out: Vec<ProjectInfo> = Vec::new();

  let rd = match fs::read_dir(root) {
    Ok(v) => v,
    Err(_) => return out,
  };

  for e in rd.flatten() {
    let p = e.path();
    if !p.is_dir() { continue; }
    let name = e.file_name().to_string_lossy().to_string();

    let run_json = p.join("run.json");
    if let Ok(s) = fs::read_to_string(run_json) {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
        let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("never").to_string();
        let finished_at = v.get("finishedAt").and_then(|x| x.as_str()).map(|x| x.to_string());
        out.push(ProjectInfo { name, last_status: status, finished_at });
        continue;
      }
    }

    out.push(ProjectInfo { name, last_status: "never".to_string(), finished_at: None });
  }

  out.sort_by(|a, b| a.name.cmp(&b.name));
  out
}

#[tauri::command]
async fn run_agent_stream(window: Window, project: String, prompt: String, build_apk: bool) -> Result<(), String> {
  let root = repo_root();
  let agent = root.join("packages/agent/src/cli.mjs");

  let mut cmd = tokio::process::Command::new("node");
  cmd.current_dir(&root)
    .arg(agent)
    .arg("--project").arg(project)
    .arg("--prompt").arg(prompt)
    .arg("--build_apk").arg(if build_apk { "1" } else { "0" })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  let mut child = cmd.spawn().map_err(|e| format!("spawn_error={e}"))?;
  let stdout = child.stdout.take().ok_or("missing_stdout")?;
  let stderr = child.stderr.take().ok_or("missing_stderr")?;

  let w_out = window.clone();
  tokio::spawn(async move {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let _ = w_out.emit("agent:log", line);
    }
  });

  let w_err = window.clone();
  tokio::spawn(async move {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let _ = w_err.emit("agent:log", line);
    }
  });

  tokio::spawn(async move {
    let ok = child.wait().await.map(|s| s.success()).unwrap_or(false);
    let _ = window.emit("agent:done", if ok { "success" } else { "failed" });
  });

  Ok(())
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![run_agent_stream, list_projects_with_status])
    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}
