import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Status = "idle" | "running" | "success" | "failed";

export default function App() {
  const [projects, setProjects] = useState<string[]>([]);
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");

  const logText = useMemo(() => logs.join("\n"), [logs]);

  // load project list on startup
  useEffect(() => {
    refreshProjects();
  }, []);

  async function refreshProjects() {
    const list = await invoke<string[]>("list_projects");
    setProjects(list);
    if (!project && list.length > 0) setProject(list[0]);
  }

  useEffect(() => {
    const unlistenPromises = [
      listen<string>("agent:log", (e) => {
        setLogs((prev) => [...prev, String(e.payload)]);
      }),
      listen<string>("agent:done", (e) => {
        setLogs((prev) => [...prev, `\n[done] ${e.payload}`]);
        setStatus(e.payload === "success" ? "success" : "failed");
      }),
    ];
    return () => {
      unlistenPromises.forEach(async (p) => (await p)());
    };
  }, []);

  async function onRun() {
    if (!project || status === "running") return;
    setLogs([]);
    setStatus("running");
    await invoke("run_agent_stream", { project, prompt });
  }

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "220px 1fr" }}>
      {/* Sidebar */}
      <div style={{ borderRight: "1px solid #222", padding: 12 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Projects</div>
        {projects.map((p) => (
          <div
            key={p}
            onClick={() => setProject(p)}
            style={{
              padding: "6px 8px",
              borderRadius: 6,
              cursor: "pointer",
              background: p === project ? "#333" : "transparent",
            }}
          >
            {p}
          </div>
        ))}
      </div>

      {/* Main */}
      <div style={{ padding: 16, display: "grid", gridTemplateRows: "auto auto 1fr", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Beschreibe die App…"
            style={{ padding: 10, borderRadius: 8 }}
          />
          <button
            onClick={onRun}
            disabled={status === "running"}
            style={{ padding: "10px 14px", fontWeight: 600 }}
          >
            {status === "running" ? "Running…" : "Run"}
          </button>
        </div>

        <div>Status: <b>{status}</b></div>

        <textarea
          readOnly
          value={logText}
          style={{
            width: "100%",
            height: "100%",
            fontFamily: "monospace",
            fontSize: 12,
            padding: 12,
          }}
        />
      </div>
    </div>
  );
}
