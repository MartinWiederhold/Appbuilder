import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { invoke } from "@tauri-apps/api/core";
import { deriveBmadPhase, phaseLabel, type RunJson } from "./bmad_phase";

export default function App() {
  const [run, setRun] = useState<RunJson | null>(null);

  const phase = useMemo(() => deriveBmadPhase(run), [run]);
  const label = useMemo(() => phaseLabel(phase), [phase]);

  async function readRunJson() {
    try {
      const raw = await invoke<string>("read_run_json_project", {
        project: "todo_flutter",
      });
      const json = JSON.parse(raw) as RunJson;
      setRun(json);
    } catch (e) {
      console.error("read_run_json failed", e);
    }
  }

  useEffect(() => {
    const id = window.setInterval(() => {
      void readRunJson();
    }, 500);
    void readRunJson();
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div>
            <div className="brandTitle">Flutter Builder</div>
            <div className="brandSub">BMAD Status: {label}</div>
          </div>
        </div>

        <div className="sectionTitle">Current phase</div>
        <div className="recent">{label}</div>

        <div className="sectionTitle">Last result</div>
        <div className="recent">status: {run?.status ?? "n/a"}</div>
        <div className="recent">lastStep: {run?.lastStep ?? "n/a"}</div>
        <div className="recent">exitCode: {String(run?.exitCode ?? "n/a")}</div>
      </aside>

      <main className="main">
        <div className="hero">
          <div className="headline">Got an idea?</div>
        </div>
      </main>
    </div>
  );
}
