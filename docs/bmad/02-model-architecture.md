# BMAD-M: Model & Architecture (V0.1)

## Komponenten
- Desktop UI (Tauri + React)
- Agent (Node): Project Generator + Runner
- Log Parser: Logs -> Structured Issues
- Fixer: Claude Prompting -> Unified Diff
- Patcher: Apply Diff sicher (git apply) + Rollback
- BMAD Engine: State machine + Gates + Stop/Continue

## Datenfluss
UI -> Agent -> Runner -> Logs -> Parser -> Issues -> Fixer(Claude) -> Diff -> Patcher -> Runner

## Sicherheitsregeln
- Command Whitelist
- Projekte nur unter workspace/projects/*
- Jede Auto-Fix Runde erzeugt ein Git Snapshot
