# GTD Command Centre

Personal productivity platform built on the Getting Things Done method.

**Capture. Clarify. Organise. Reflect. Engage.**

## Phase 1 (current)
- Full GTD web app as an installable PWA (works offline, Add to Home Screen on Android)
- Desktop: connects directly to a local `tasks.json` via the File System Access API
- Mobile/other browsers: browser-side storage with export/import backup

## Planned modules
- **Phase 2** — user accounts (Supabase), cloud sync, delegation to other users with a lightweight recipient Tasks app
- **Phase 3** — money ledger per person: floats given, spends recorded with receipt photos, running balance (including negative balances)

## Structure
Single self-contained `index.html` — no frameworks, no build step, no external dependencies.

Deployed via GitHub Pages from the `main` branch.
