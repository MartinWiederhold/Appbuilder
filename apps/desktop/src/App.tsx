import { useMemo, useState } from "react";
import "./App.css";

type BmadPhase = "B" | "M" | "A" | "D";

export default function App() {
  const [phase, setPhase] = useState<BmadPhase>("B");
  const [prompt, setPrompt] = useState("");
  const [logs, setLogs] = useState<string[]>([
    "Flutter Builder • Ready",
    "BMAD Phase: B (Business & Scope)",
  ]);

  const phaseLabel = useMemo(() => {
    switch (phase) {
      case "B": return "B — Business & Scope";
      case "M": return "M — Model & Architecture";
      case "A": return "A — App Core";
      case "D": return "D — Design & UX";
    }
  }, [phase]);

  function appendLog(line: string) {
    setLogs((prev) => [...prev, line]);
  }

  function onRun() {
    const p = prompt.trim();
    if (!p) return appendLog("⚠ Please enter a prompt first.");
    appendLog(`▶ Prompt: ${p}`);
    appendLog("…(wire to agent later)");
    setPrompt("");
  }

  function onMenuPick(v: string) {
    appendLog(`☰ Menu: ${v} (hook later)`);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandDot" />
          <div>
            <div className="brandTitle">Flutter Builder</div>
            <div className="brandSub">{phaseLabel}</div>
          </div>
        </div>

        <div className="nav">
          <div className="navItem active">Home</div>
          <div className="navItem">Search</div>
          <div className="navItem">Resources</div>
        </div>

        <div className="sectionTitle">Projects</div>
        <div className="nav">
          <div className="navItem">All projects</div>
          <div className="navItem">Starred</div>
          <div className="navItem">Created by me</div>
          <div className="navItem">Shared with me</div>
        </div>

        <div className="sectionTitle">Recents</div>
        <div className="recents">
          <div className="recent">todo_flutter</div>
          <div className="recent">project-alpha</div>
          <div className="recent">vylo-z-rich-connect</div>
        </div>

        <div className="phaseBar">
          <span>BMAD</span>
          <div className="phaseBtns">
            {(["B","M","A","D"] as const).map((p) => (
              <button
                key={p}
                className={p === phase ? "chip chipActive" : "chip"}
                onClick={() => { setPhase(p); appendLog(`Phase switched: ${p}`); }}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="hero">
          <div className="headline">Got an idea?</div>

          <div className="promptCard">
            <button className="plusBtn" title="Add" onClick={() => onMenuPick("Open menu")}>+</button>

            <select
              className="menuSelect"
              defaultValue=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) onMenuPick(v);
                e.currentTarget.value = "";
              }}
            >
              <option value="" disabled>Attach / Design / Connectors…</option>
              <option value="Attach">Attach</option>
              <option value="Design">Design</option>
              <option value="Connectors">Connectors</option>
            </select>

            <input
              className="promptInput"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask Builder to create…"
              onKeyDown={(e) => { if (e.key === "Enter") onRun(); }}
            />

            <button className="sendBtn" title="Send" onClick={onRun}>↑</button>
          </div>

          <div className="hint">
            Next: prompt → agent (BMAD) → generate/update workspace/projects/&lt;name&gt; → show diffs + preview
          </div>
        </div>

        <div className="contentRow">
          <section className="preview">
            <div className="panelTitle">Live mockup</div>
            <div className="panelBody">Preview kommt später.</div>
          </section>

          <section className="logs">
            <div className="panelTitle">Logs</div>
            <div className="panelBody mono">
              {logs.map((l, i) => (<div key={i}>{l}</div>))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
