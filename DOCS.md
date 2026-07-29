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

## Next actions — context filters and subtasks (gtdcc-v47)

**Context filter chips.** A chip row sits at the top of Next actions, one chip
per context actually in use (plus "No context" and "All"), each with a live
count. Chips multi-select — tapping two contexts shows both lists. The
selection persists in `localStorage` under `gtdcc-ctxfilter`, but is read
lazily through `ctxFilter()` and validated on every read, so a corrupt value
can never become a boot input.

**Task hierarchy.** Tasks carry `parentId`. Any task can be converted into a
subtask of another via **Make subtask of…** in the task drawer, or created
directly under a parent from the inline box in the expanded list row (the
"go to the shop → shopping list" pattern). Subtasks inherit the parent's
context, project and area.

Deliberately **one level only**: `TaskService.canBeChildOf()` refuses a parent
that is already a subtask, and refuses to demote a task that has subtasks of
its own. That removes cycles and chains entirely.

Behaviour:
- Subtasks are hidden from Next actions, All outstanding, the Focus engine
  pool and the sidebar count — they appear under their parent.
- The parent row shows a `done/total` toggle that expands the checklist.
- Completing a parent completes its open subtasks (one undo restores all).
- Deleting a parent detaches its children rather than orphaning them.
- The old lightweight `subtasks[]` checklist remains, now labelled
  **Quick checklist** in the drawer, for throwaway items that never need to
  be real tasks.

## Delegation is free text (gtdcc-v48)

Delegation no longer depends on the person having an app account. The delegate
modal takes **any name** as free text, with a `<datalist>` of suggestions drawn
from both app accounts and every name already used in the app
(`peopleNames()`). `matchAccount()` decides what happens on send:

- **Name matches an account** — unchanged behaviour: a `cloud_tasks` row, a
  WhatsApp message and a push, so it lands in their Tasks app.
- **Name matches nothing** — the task moves to Waiting for with the typed name,
  note and expected date. No cloud row, no error.

The modal states which of the two will happen and relabels its button
accordingly, so the outcome is never a surprise. The Delegate button is now
offered even when signed out, since local delegation needs no account.

`CloudService.peopleCache` backs the suggestions and is only ever overwritten
by a **non-empty** response — a failed or empty fetch must not wipe known names
mid-interaction. The delegate modal redraws after a background refresh only if
the name list actually changed.

**Smart capture review cards** now carry an editable **Notes** textarea (saved
to `task.notes`) and an editable **Delegated to** input, pre-filled from the
analysis. A name in that box is decisive: the task is created as Waiting for
with that person, whether or not they have an account. Nothing is sent to the
cloud silently — the toast says how many of the new tasks could also be pushed
to a Tasks app via the task's own Delegate button.
