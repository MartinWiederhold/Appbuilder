import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>(["Flutter Builder • Ready"]);
  const [busy, setBusy] = useState(false);

  function append(line: string) {
    setLogs((p) => [...p, line]);
  }

  async function runAgent() {
    if (busy) return;
    setBusy(true);
    append("▶️ Running agent…");

    try {
      const out = await invoke<string>("run_agent");
      out.split("\n").filter(Boolean).forEach(append);
      append("✅ Agent finished.");
    } catch (e: any) {
      append("❌ Agent failed.");
      append(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ height: "100vh", display: "grid", gridTemplateColumns: "1.2fr 1fr" }}>
      <div style={{ padding: 16 }}>
        <h2 style={{ margin: 0 }}>Flutter Builder</h2>
        <p style={{ opacity: 0.75, marginTop: 6 }}>BMAD Phase 1.4 — Agent MVP</p>

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
            {busy ? "Running…" : "Run Agent"}
          </button>
          <button
            onClick={() => {
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
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Logs</div>
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
        </div>
      </div>
    </div>
  );
}
