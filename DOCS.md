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

## Smart capture: long pastes (gtdcc-v49 / smart-capture v11)

**Root cause of dropped tasks.** The function asked for `max_tokens: 2000`.
A dozen tasks with prose descriptions exceed that, so the model's JSON was cut
mid-object, `JSON.parse` threw, and the whole batch was discarded — the user saw
a short list or an error, with no indication anything was missing.

Three changes, all needed:

1. `max_tokens` 2000 → **16000**. This alone covers any realistic paste.
2. **`extractArray()` salvage.** If parsing still fails, complete objects are
   recovered from the truncated `tasks` / `finance_*` / `expenses` arrays by
   string-aware brace matching (braces and escaped quotes inside titles and
   descriptions do not confuse the scanner). The incomplete tail object is
   dropped. Response carries `truncated:true, recovered:true`.
3. **Prompt**: descriptions capped at one sentence under 20 words, and an
   explicit instruction to extract every task including those at the end.

A response that completes but hits the ceiling (`stop_reason === "max_tokens"`)
is also flagged `truncated`.

The console shows a **CUT SHORT** band when `out.truncated` and always prints
the task count in the section heading, so a short list is visible rather than
assumed complete.

**Note on the function source:** the repo copy was stale (v9) while v10 was
live. The deployed source was recovered from the eszip sourcemap before
editing, so nothing was regressed. `supabase/functions/smart-capture/index.ts`
now matches deployed v11 — keep it that way.

## Smart capture: dropped items (gtdcc-v50 / smart-capture v14)

Raising `max_tokens` fixed truncation but not the real complaint. Replaying
Rodney's 13-item meeting-notes paste against the live function showed the
first pass returning **10 of 13** on some runs and 13 on others — the model
silently drops items from long lists, and a dropped item is invisible.

Three changes:

1. **Prompt**: exhaustiveness stated as the priority; explicit ban on merging,
   deduping or grouping similar items; an already-structured list maps one task
   per listed item, in order. This overrides even user rules asking for a short
   output (verified adversarially).
2. **`item_count`**: the model declares how many items it found. A shorter
   `tasks` array than that sets `incomplete`.
3. **Reconciliation sweep**: for long material, a second call shows the model
   its own first-pass titles and asks *only* for what it missed. Additive by
   construction — it cannot remove anything, and results are deduped on a
   normalised title. `swept` is always reported (including `0`) so a sweep that
   silently no-ops is visible. Skipped in finance mode.

Observed working: a run with `first_pass: 10, swept: 3` returned all 13.

**Delegation accuracy.** Explicit markers ("Owner:", "Delegated to:",
"Assigned to:") are now honoured exactly. "Delegated to: (none)" or "Owner:
you" means `person = null`, and a name appearing only in prose ("send it to
Ingrid", "work with Mihail") is no longer treated as an assignee.

The console shows the task count, a **MAY BE INCOMPLETE** band when the counts
disagree, and how many tasks the second pass recovered.

**Diagnosis note:** the function was tested live by calling it with the
service-role key as bearer. Nothing was made public and no test users created.

## Next actions: group heading order (gtdcc-v51)

`UI.next` grouped tasks by a display label and then sorted the headings with a
plain `Object.keys(groups).sort()` — i.e. alphabetically on the rendered text.
So "01 Aug 2026" sorted before "30 Jul 2026", and priority ran Critical, High,
Low, Normal.

Each grouping now supplies its own sort token via `sortFn`, captured into
`groupSort` as the buckets are built:

| Group | Sorted by |
|---|---|
| due | the raw ISO date (`YYYY-MM-DD` sorts correctly as text) |
| priority | critical → high → normal → low |
| energy | high → medium → low |
| context / project / area | name, case-insensitive |

The "none" bucket (No due date, No context, Standalone, No area) is prefixed
`2` against `1` for everything else, so it always lands last rather than being
alphabetised among real values. Ties fall back to label order.

**Lesson:** never sort group headings by their display string. Formatted dates,
capitalised enums and localised month names all sort wrongly. Keep the sort key
separate from the label.

Note for tests: `toLocaleDateString("en-GB", {month:"short"})` renders September
as **"Sept"**, not "Sep". Assert against `fmtDate()` output rather than
hard-coded date strings.
