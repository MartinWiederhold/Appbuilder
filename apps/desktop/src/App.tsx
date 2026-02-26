import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type AgentLogPayload = string;

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const logText = useMemo(() => logs.join("\n"), [logs]);

  useEffect(() => {
    const unlistenPromises = [
      listen<AgentLogPayload>("agent:log", (event) => {
        setLogs((prev) => [...prev, String(event.payload)]);
      }),
      listen<string>("agent:done", (event) => {
        setLogs((prev) => [...prev, `\n[done] ${String(event.payload)}`]);
        setRunning(false);
      }),
    ];

    return () => {
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

    await invoke("run_agent_stream", { prompt });
  }

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateRows: "auto 1fr", gap: 12, padding: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Beschreibe die App… (Phase 1.3: nur Dummy)"
          style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #333", background: "#111", color: "#fff" }}
        />
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
  );
}
