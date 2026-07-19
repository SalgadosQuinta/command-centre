# GTD Console & Tasks App — Developer Documentation

**Repo:** github.com/SalgadosQuinta/command-centre. Two single-file apps:
`index.html` (the GTD console, Rodney's) and `tasks/index.html` (assignees' task
list, e.g. the assistant). Same architecture rules as Julius Family Money —
read `family-money/DOCUMENTATION.md` §1–2 first; this file covers what differs.

## GTD console (`index.html`)
- **Data model:** local-first. `AppState.data` (projects, tasks, goals, notes,
  clients, waContacts-era leftovers) persists to a local data file and syncs to
  Supabase `user_state` (one row per user). Cloud-shared work uses
  `cloud_tasks` (owner_id, assignee_id, status, comments, attachments jsonb).
- **Views** are functions on `UI` keyed by `AppState.currentView`, rendered by
  `render()`. Async data (Money summary, goal metrics, notification admin)
  renders placeholders then fills via `fillMoneySummary` / `fillGoalMetrics` /
  `fillNotifyAdmin`, hooked at the end of `render()`.
- **Navigation:** desktop rail with collapsible sections (state `gtd_navfold`);
  mobile = 5-button strip + top accordion menu (`#mobMenu`, state `gtd_mobsec`),
  both built from the same group list — keep them in sync when adding views.
- **Money integration:** Money view and goal metrics read `fam_*` tables from
  the shared Supabase (RLS applies; Rodney sees all spaces). Finance view was
  renamed **Pipeline** and is speculative CRM revenue only; `financeIsConfirmed`
  gates what counts as expected money (manual confirm / invoiced / client won).
- **WhatsApp notifications:** `WhatsAppService` reads admin-managed
  `fam_notify_prefs` (managed in Settings here, or Family Money Admin — same
  table) and posts to the `notify-whatsapp` Edge Function
  (CallMeBot gateway; per-recipient opt-in key). Events: `task_assigned`
  (default on), `task_updated` (opt-in). Sends fire from the person task modal
  and `CloudService.delegate`.
- **Tests:** `tests/run-tests.js` (uses family-money's node_modules via
  symlink: `ln -sfn ../family-money/node_modules node_modules`, remove after).
  Mix of pure-function extraction (`extractFn`) and jsdom DOM suites. Never
  deploy red. Service worker `gtdcc-vN` bump every deploy; tasks app has its
  own `tasksapp-vN`.

## Tasks app (`tasks/index.html`)
Minimal by design: login, list of `cloud_tasks` assigned to me, status changes,
comments, attachment viewing (signed URLs from the `receipts` bucket,
`task-` prefix). Assignees need a profile but NOT family membership.

## Backups
GTD/task data is covered by the Supabase layers in
`family-money/BACKUP-AND-RESILIENCE.md`; additionally take a local data-file
backup from Settings whenever the weekly JSON export runs.
