import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type Status = "idle" | "running" | "success" | "failed";
type LastStatus = "success" | "failed" | "never";

type ProjectInfo = {
  name: string;
  last_status: LastStatus;
  finished_at?: string | null;
};

function badge(status: LastStatus) {
  const base: React.CSSProperties = {
    fontSize: 11,
    padding: "2px 6px",
    borderRadius: 999,
    border: "1px solid #333",
    opacity: 0.9,
  };
  if (status === "success") return <span style={{ ...base, background: "#163" }}>ok</span>;
  if (status === "failed") return <span style={{ ...base, background: "#611" }}>fail</span>;
  return <span style={{ ...base, background: "#222" }}>—</span>;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [project, setProject] = useState("");
  const [prompt, setPrompt] = useState("");
  

  const PROMPT_TEMPLATES: Record<string, string> = {
    "Todo v1": "feature: todo_v1\ntitle: Todo Pro\nhome_title: Todo Home",
    "Blank": "feature: <feature_name>\ntitle: <App Title>\nhome_title: <Home Title>",
  };

  function applyTemplate(name: string) {
    const t = PROMPT_TEMPLATES[name];
    if (!t) return;
    setPrompt(t);
  }
const [logs, setLogs] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [buildApk, setBuildApk] = useState(false);

  const logText = useMemo(() => logs.join("\n"), [logs]);

  async function refreshProjects(selectIfEmpty = true) {
    const list = await invoke<ProjectInfo[]>("list_projects_with_status");
    setProjects(list);
    if (selectIfEmpty && !project && list.length > 0) setProject(list[0].name);
  }

  useEffect(() => {
    // restore last project
    const last = localStorage.getItem("fb:lastProject");
    refreshProjects(false).then(async () => {
      if (last) setProject(last);
      else {
        const list = await invoke<ProjectInfo[]>("list_projects_with_status");
        if (!project && list.length > 0) setProject(list[0].name);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (project) localStorage.setItem("fb:lastProject", project);
  }, [project]);

  useEffect(() => {
    const unlistenPromises = [
      listen<string>("agent:log", (e) => {
        setLogs((prev) => [...prev, String(e.payload)]);
      }),
      listen<string>("agent:done", async (e) => {
        const res = String(e.payload);
        setLogs((prev) => [...prev, `\n[done] ${res}`]);
        setStatus(res === "success" ? "success" : "failed");
        await refreshProjects(false); // update sidebar badges
      }),
    ];
    return () => {
      unlistenPromises.forEach(async (p) => (await p)());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRun() {
    if (!project || status === "running") return;
    setLogs([]);
    setStatus("running");
    console.log("PROMPT_RAW:", JSON.stringify(prompt));
    await invoke("run_agent_stream", { project, prompt, buildApk });
}

  const active = projects.find((p) => p.name === project);

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "260px 1fr" }}>
      <div style={{ borderRight: "1px solid #222", padding: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={{ fontWeight: 700 }}>Projects</div>
          <button
            onClick={() => refreshProjects(false)}
            style={{ padding: "6px 10px", borderRadius: 8, border: "1px solid #333", background: "#111", color: "#fff" }}
          >
            Refresh
          </button>
        </div>

        <div style={{ display: "grid", gap: 6 }}>
          {projects.map((p) => (
            <div
              key={p.name}
              onClick={() => setProject(p.name)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 10px",
                borderRadius: 10,
                cursor: "pointer",
                background: p.name === project ? "#2a2a2a" : "transparent",
                border: p.name === project ? "1px solid #333" : "1px solid transparent",
              }}
            >
              <div style={{ display: "grid" }}>
                <div style={{ fontWeight: 600 }}>{p.name}</div>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  {p.finished_at ? new Date(p.finished_at).toLocaleString() : "never run"}
                </div>
              </div>
              {badge(p.last_status)}
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: 16, display: "grid", gridTemplateRows: "auto auto 1fr", gap: 12 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <div data-testid="prompt-templates" style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>

            {Object.keys(PROMPT_TEMPLATES).map((name) => (

              <button

                key={name}

                onClick={() => applyTemplate(name)}

                style={{ padding: "8px 10px", borderRadius: 10, border: "1px solid #333", background: "#0f0f0f", color: "#fff", cursor: "pointer" }}

              >

                {name}

              </button>

            ))}

          </div>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
            placeholder={'feature: todo_v1\ntitle: Todo Pro\nhome_title: Todo Home'}
            rows={4}
            style={{ padding: 10, borderRadius: 10, border: "1px solid #333", background: "#111", color: "#fff", resize: "vertical" }}
          />
          <button
            onClick={onRun}
            disabled={status === "running"}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: status === "running" ? "#222" : "#fff",
              color: status === "running" ? "#aaa" : "#000",
              cursor: status === "running" ? "not-allowed" : "pointer",
              fontWeight: 700,
            }}
          >
            {status === "running" ? "Running…" : "Run"}
          </button>
        </div>

        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div>
            Active: <b>{project || "—"}</b> · Status: <b>{status}</b>
            {active?.last_status ? <span style={{ marginLeft: 8, opacity: 0.7 }}>(last: {active.last_status})</span> : null}
          </div>

          <label style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", userSelect: "none" }}>
            <input
              type="checkbox"
              checked={buildApk}
              onChange={(e) => setBuildApk(e.target.checked)}
              disabled={status === "running"}
            />
            Build APK (debug)
          </label>
        </div>

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
      </div>
    </div>
  );
}
