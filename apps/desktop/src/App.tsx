import { useEffect, useMemo, useState } from "react";
import RunStatusCard from "./components/RunStatusCard";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { deriveBmadPhase, type RunJson } from "./bmad_phase";

type AgentLogPayload = string;

type ProjectInfo = {
  name: string;
  last_status: string;
  finished_at?: string | null;
};


export default function App() {
  
  
  const [status, setStatus] = useState<string>('idle');

  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const res = await fetch('/run.json?_=' + Date.now());
        if (!res.ok) return;
        const j = await res.json();
        if (j?.status === 'success') setStatus('done');
        if (j?.status === 'running') setStatus('running');
        if (j?.status === 'error' || j?.exitCode > 0) setStatus('error');
      } catch {}
    }, 500);
    return () => clearInterval(id);
  }, []);
const [agentStatus, setAgentStatus] = useState<string>('idle');
const [project, setProject] = useState("todo_flutter");
  const [buildApk, setBuildApk] = useState(false);
  const [livePreview, setLivePreview] = useState(true);
  const [stopAfter, setStopAfter] = useState<"never" | "generate">("never");
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);

  const [running, setRunning] = useState(false);
  const [runJson, setRunJson] = useState<RunJson | null>(null);
  const [tab, setTab] = useState<"logs" | "changes">("logs");
  const [statusText, setStatusText] = useState("");
  const [diffText, setDiffText] = useState("");


  const logText = useMemo(() => logs.join("\n"), [logs]);
  const bmadPhase = deriveBmadPhase(runJson, running);

  useEffect(() => {
    
    const unlisten = window.__TAURI__?.event?.listen?.('agent:stdout', (e:any) => {
      const line = String(e?.payload || '');
      if (line.includes('AGENT_STATUS:RUNNING')) setAgentStatus('running');
      if (line.includes('AGENT_STATUS:RELOAD_OK')) setAgentStatus('reload_ok');
      if (line.includes('AGENT_STATUS:DONE')) setAgentStatus('done');
    });
(async () => {
      try {
        const items = await invoke<ProjectInfo[]>("list_projects_with_status");
        setProjects(items);
        if (!project && items.length) setProject(items[0].name);
      } catch (e: any) {
        setLogs((prev) => [...prev, `[ui] ⚠️ could not load projects: ${String(e)}`]);
      }
    })();

    const unlistenPromises = [
      listen<AgentLogPayload>("agent:log", (event) => {
        setRunning(true);
        setLogs((prev) => [...prev, String(event.payload)]);
      }),
      listen<string>("agent:done", async (event) => {
        setLogs((prev) => [...prev, `\n[done] ${String(event.payload)}`]);
        setRunning(false);
        try {
          const st = await invoke<string>("git_status_project", { project });
          const df = await invoke<string>("git_diff_project_v2", { project });
          setStatusText(st || "");
          setDiffText(df || "");
        } catch (e: any) {
          setStatusText("");
          setDiffText(`(could not load diff) ${String(e)}`);
        }

      }),
    ];

    return () => {
      try { if (unlisten?.then) unlisten.then((f:any)=>f()); } catch {}
      unlistenPromises.forEach(async (p) => {
        try {
          const unlisten = await p;
          unlisten();
        } catch {
          // ignore
        }
      });
    };
  }, []);

async function onRun() {
    if (running) return;
    setLogs([]);
    setRunning(true);

    const raw = prompt.replace(/\r\n/g, "\n");

    if (!raw.trim()) {
      setLogs((prev) => [...prev, "[ui] ❌ Prompt ist leer. Bitte feature/title/home_title eingeben."]);
      setRunning(false);
      return;
    }
    if (!project.trim()) {
      setLogs((prev) => [...prev, "[ui] ❌ Project ist leer. Bitte z.B. todo_flutter eintragen."]);
      setRunning(false);
      return;
    }

    try {
      // IMPORTANT: Rust erwartet project, prompt, build_apk
            await invoke("set_run_config", { cfg: { live_preview: livePreview, stop_after: stopAfter } });
      await invoke("run_agent_stream", { project, prompt: raw, buildApk });
      await invoke("start_live_flutter");
    } catch (e: any) {
      setLogs((prev) => [...prev, `[ui] ❌ invoke failed: ${String(e)}`]);
      setRunning(false);
    }
  }

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateRows: "auto 1fr", gap: 12, padding: 16 }}>
      <div style={{ color: "#aaa", fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>BMAD Phase: {bmadPhase}</div>
    <RunStatusCard bmadPhase={bmadPhase} />
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center" }}>
          
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            style={{
              width: "100%",
              padding: 10,
              borderRadius: 10,
              border: "1px solid #333",
              background: "#111",
              color: "#fff",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
            }}
          >
            {projects.length === 0 ? (
              <option value="todo_flutter">todo_flutter</option>
            ) : (
              projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}  ·  {p.last_status}
                </option>
              ))
            )}
          </select>
<label style={{ display: "flex", gap: 8, alignItems: "center", color: "#aaa", fontSize: 12 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#aaa", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={livePreview}
              onChange={(e) => setLivePreview(e.target.checked)}
            />
            Live Preview
          </label>

          <label style={{ display: "flex", gap: 8, alignItems: "center", color: "#aaa", fontSize: 12 }}>
            Stop after
            <select
              value={stopAfter}
              onChange={(e) => setStopAfter(e.target.value as any)}
              style={{
                background: "#111",
                color: "#fff",
                border: "1px solid #333",
                borderRadius: 8,
                padding: "6px 8px",
                fontSize: 12,
              }}
            >
              <option value="never">never</option>
              <option value="generate">generate</option>
            </select>
          </label>

            <input
              type="checkbox"
              checked={buildApk}
              onChange={(e) => setBuildApk(e.target.checked)}
            />
            Build APK
          </label>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`feature: todo_v1\ntitle: Todo Pro\nhome_title: Todo Home`}
          rows={4}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.4,
            resize: "vertical",
            whiteSpace: "pre-wrap",
          }}
        />

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={onRun}
            disabled={running}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: running ? "#222" : "#fff",
              color: running ? "#aaa" : "#000",
              cursor: running ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {running ? "Running…" : "Run"}
          </button>
          <button
            onClick={() => invoke("reveal_project", { project })}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: "#111",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Reveal Project
          </button>

          <div style={{ display: "flex", gap: 8, marginLeft: 8 }}>
            <button
              onClick={() => setTab("logs")}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #333",
                background: tab === "logs" ? "#fff" : "#111",
                color: tab === "logs" ? "#000" : "#fff",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Logs
            </button>
            <button
              onClick={() => setTab("changes")}
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #333",
                background: tab === "changes" ? "#fff" : "#111",
                color: tab === "changes" ? "#000" : "#fff",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Changes
            </button>
          </div>

          <div style={{ color: "#aaa", fontSize: 12 }}>
            LIVE_PREVIEW wird nach agent:done getriggert (wenn LIVE_PREVIEW=1 und STOP_AFTER=never).
          </div>
        </div>
      </div>

      
      {tab === "logs" ? (
        <textarea
          readOnly
          value={logText}
          style={{
            width: "100%",
            height: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#0b0b0b",
            color: "#d6d6d6",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        />
      ) : (
        <div style={{
          width: "100%",
          height: "100%",
          display: "grid",
          gridTemplateRows: "auto 1fr",
          gap: 10,
        }}>
          <textarea
            readOnly
            value={statusText || "(no changes)"}
            style={{
              width: "100%",
              height: 120,
              padding: 12,
              borderRadius: 12,
              border: "1px solid #333",
              background: "#0b0b0b",
              color: "#d6d6d6",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.4,
            }}
          />
          <textarea
            readOnly
            value={diffText || "(no diff)"}
            style={{
              width: "100%",
              height: "100%",
              padding: 12,
              borderRadius: 12,
              border: "1px solid #333",
              background: "#0b0b0b",
              color: "#d6d6d6",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.4,
            }}
          />
        </div>
      )}


    </div>
  );
}
