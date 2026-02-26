# BMAD-B: Business & Scope (V0.1)

## Ziel
Ein lokales macOS Desktop-Tool (wie Cursor als App im Dock), das aus einem Prompt ein Flutter-App-Projekt erstellt/ändert und Builds automatisiert.

## Zielgruppe
Nur ich (lokal). Kein SaaS, keine Kunden, keine Multi-User.

## In-Scope (V0.1)
- macOS Desktop App (Tauri) mit:
  - Prompt-Eingabe
  - Projektliste (lokal)
  - Live Logs (Agent/Build)
  - Anzeige aktuelle BMAD-Phase + Stop/Continue
- Lokaler Agent (Node), der:
  - Flutter-Projekt aus Template kopiert
  - flutter analyze / test / build (Android) ausführt
  - Logs sammelt und als Issues strukturiert
- Auto-Fix v0:
  - Bei Fehler: Logs -> Claude -> Unified Diff -> anwenden -> Retry (max N)
  - Jede Fix-Runde ist revertierbar (git snapshot)

## Out-of-Scope (V0.1)
- Vollautomatisches Provisioning (Firebase/Supabase/Netlify/SendGrid/Apple)
- One-click Store Publish
- iOS IPA Signing/Distribution
- Cloud Sync / Accounts fürs Tool
- Vollständige Premium-Qualitätsgarantie (nur Gates/Checks)

## Erfolgskriterien
- <= 10 Minuten: neues Flutter-Projekt generieren + flutter analyze grün
- <= 30 Minuten: Android AAB buildbar (Template)
- Auto-Fix behebt mindestens 5 definierte Fehlerklassen ohne manuelle Code-Edits

## Risiken
- AI Fix-Loops -> braucht Retry Limits + Diff Review + Rollback
- Secrets Handling -> vorerst lokal, später Keychain
