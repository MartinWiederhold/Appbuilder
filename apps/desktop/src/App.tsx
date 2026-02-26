import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

export default function App() {
  const [projectName, setProjectName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>(["Flutter Builder • Ready"]);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  function append(line: string) {
    setLogs((p) => [...p, line]);
  }

  useEffect(() => {
    let unlistenLog: null | (() => void) = null;
    let unlistenDone: null | (() => void) = null;

    (async () => {
      unlistenLog = await listen<string>("agent:log", (event) => {
        append(event.payload);
      });

      unlistenDone = await listen<string>("agent:done", (event) => {
        append(`✅ Agent finished (${event.payload}).`);
        setBusy(false);
      });
    })();

    return () => {
      if (unlistenLog) unlistenLog();
      if (unlistenDone) unlistenDone();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  async function runAgent() {
    if (busy) return;

    const name = projectName.trim();
    if (!name) {
      append("⚠️ Please enter a project name first.");
      return;
    }

    setBusy(true);
    append(`▶️ Starting agent for project: ${name}`);

    try {
      await invoke("run_agent_stream", { projectName: name, prompt });
    } catch (e: any) {
      append("❌ Failed to start agent.");
      append(String(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "1.2fr 1fr" }}>
      <div style={{ padding: 16 }}>
        <h2 style={{ margin: 0 }}>Flutter Builder</h2>
        <p style={{ opacity: 0.75, marginTop: 6 }}>BMAD Phase 1.6 — Live Log Streaming</p>

        <div style={{ marginTop: 12, fontWeight: 600 }}>Project name</div>
        <input
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder='z.B. "todo_app3"'
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.04)",
            color: "inherit",
            outline: "none",
          }}
        />

        <div style={{ marginTop: 12, fontWeight: 600 }}>Prompt</div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Beschreibe die App… (wird später genutzt)"
          style={{
            width: "100%",
            height: 220,
            resize: "vertical",
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(255,255,255,0.04)",
            color: "inherit",
            outline: "none",
          }}
        />

        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          <button onClick={runAgent} disabled={busy}>
            {busy ? "Running…" : "Create + Analyze (Stream)"}
          </button>
          <button
            onClick={() => {
              setProjectName("");
              setPrompt("");
              setLogs(["Flutter Builder • Ready"]);
            }}
            disabled={busy}
          >
            Reset
          </button>
        </div>
      </div>

      <div style={{ padding: 16, borderLeft: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Logs (live)</div>
        <div
          style={{
            height: "calc(100% - 28px)",
            overflow: "auto",
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.25)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {logs.join("\n")}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
