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

    // IMPORTANT: keep prompt EXACTLY as typed (incl. newlines)
    const raw = prompt.replace(/\r\n/g, "\n");
    console.log("PROMPT_RAW:", JSON.stringify(raw));

    await invoke("run_agent_stream", { prompt: raw });
  }

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateRows: "auto 1fr", gap: 12, padding: 16 }}>
      <div style={{ display: "grid", gap: 8 }}>
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

          <div style={{ color: "#aaa", fontSize: 12 }}>
            Prompt wird jetzt inkl. Zeilenumbrüchen gesendet.
          </div>
        </div>
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
