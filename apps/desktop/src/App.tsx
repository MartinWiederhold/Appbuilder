import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type AgentLogPayload = string;
type Phase = "idle" | "generate" | "analyze" | "test" | "reload" | "done" | "error";
type Provider = "openai" | "anthropic";

export default function App() {
  const [project, setProject] = useState("todo_flutter");
  const [provider, setProvider] = useState<Provider>("openai");
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const logText = useMemo(() => logs.join("\n"), [logs]);

  useEffect(() => {
    const unlistenPromises = [
      listen<AgentLogPayload>("agent:log", (event) => {
        const line = String(event.payload);
        setLogs((prev) => [...prev, line]);
      }),
      listen<string>("agent:done", (event) => {
        const msg = `\n[done] ${String(event.payload)}`;
        setLogs((prev) => [...prev, msg]);
        setRunning(false);
      }),
      listen<string>("phase:update", (event) => {
        const next = String(event.payload) as Phase;
        setPhase(next);
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
    setPhase("idle");

    const raw = prompt.replace(/\r\n/g, "\n");

    try {
      await invoke("run_agent", {
        project,
        provider,
        prompt: raw,
      });
    } catch (e) {
      const msg = `[ui] invoke error: ${String(e)}`;
      setLogs((prev) => [...prev, msg]);
      setPhase("error");
      setRunning(false);
    }
  }

  const phaseItems: Array<{ key: Phase; label: string }> = [
    { key: "generate", label: "Generate" },
    { key: "analyze", label: "Analyze" },
    { key: "test", label: "Test" },
    { key: "reload", label: "Reload" },
    { key: "done", label: "Done" },
  ];

  function getPhaseStyle(item: Phase) {
    const order: Phase[] = ["idle", "generate", "analyze", "test", "reload", "done"];
    const currentIndex = order.indexOf(phase);
    const itemIndex = order.indexOf(item);

    const active = phase === item;
    const completed = currentIndex > itemIndex && phase !== "error";

    return {
      border: active ? "1px solid #ffffff" : "1px solid #333",
      background: active ? "#ffffff" : completed ? "#1a1a1a" : "#111",
      color: active ? "#000" : completed ? "#9ee37d" : "#bbb",
    };
  }

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "auto auto 1fr",
        gap: 12,
        padding: 16,
        background: "#0b0b0b",
        color: "#fff",
      }}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="Project name"
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontSize: 14,
          }}
        />

        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontSize: 14,
          }}
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`feature: todo_v1\ntitle: Todo Pro\nhome_title: Todo Home`}
          rows={6}
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

          <div style={{ color: "#aaa", fontSize: 13 }}>
            {phase === "idle" ? "Bereit" : `Phase: ${phase}`}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        {phaseItems.map((item) => (
          <div
            key={item.key}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              textAlign: "center",
              fontSize: 12,
              fontWeight: 700,
              ...getPhaseStyle(item.key),
            }}
          >
            {item.label}
          </div>
        ))}
      </div>

      <textarea
        readOnly
        value={logText}
        style={{
          width: "100%",
          height: "100%",
          padding: 12,
          borderRadius: 12,
          border: phase === "error" ? "1px solid #ff6b6b" : "1px solid #333",
          background: "#111",
          color: "#ddd",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          resize: "none",
        }}
      />
    </div>
  );
}
