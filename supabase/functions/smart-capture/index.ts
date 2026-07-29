// Smart capture — Supabase Edge Function
// Holds the Anthropic API key server-side and turns pasted text /
// screenshots into structured GTD tasks for signed-in users.
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy new function
//         name: smart-capture  -> paste this file -> Deploy
// Secret: Edge Functions -> Secrets -> add ANTHROPIC_API_KEY

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

/* Pull complete objects out of a JSON array even when the surrounding document
   is truncated mid-way. A long meeting-notes paste can exhaust the response
   budget; losing the whole batch because the tail was cut is far worse than
   handing back the tasks that did arrive. String-aware so braces inside task
   titles and descriptions do not confuse the depth count. */
function extractArray(src: string, key: string): Record<string, unknown>[] {
  const marker = `"${key}"`;
  const ki = src.indexOf(marker);
  if (ki < 0) return [];
  const br = src.indexOf("[", ki + marker.length);
  if (br < 0) return [];
  const out: Record<string, unknown>[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = br + 1; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") { if (depth === 0) start = i; depth++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(src.slice(start, i + 1))); } catch { /* incomplete tail object: drop it */ }
        start = -1;
      }
      continue;
    }
    if (c === "]" && depth === 0) break;   // end of this array
  }
  return out;
}

function extractSummary(src: string): string {
  const m = src.match(/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return "";
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { text, images, documents, rules, contexts, projects, areas, people, today, mode } =
      await req.json();

    if (!text && !(images && images.length) && !(documents && documents.length)) {
      return json({ error: "Nothing to analyse" }, 400);
    }

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) {
      return json(
        { error: "ANTHROPIC_API_KEY secret is not set in Supabase" },
        500,
      );
    }

    const financeSystem = `You read photographed or scanned financial documents — bills, invoices, receipts, bank statements, utility letters — plus any pasted text, for a family money manager.

Today's date: ${today || new Date().toISOString().slice(0, 10)} (resolve relative dates with it).

Extract every distinct money item you can actually see. Never invent amounts or dates.
- finance_payments: money the user must PAY (bills, invoices, amounts due) — {"name","amount","currency","due_date","recurring":"none|weekly|monthly|quarterly|annually","category"}. Use the payee/service as name. due_date null if not stated.
- finance_revenue: money the user will RECEIVE — {"name","client","amount","currency","expected_date","recurring"}.
- expenses: money ALREADY SPENT (till receipts, paid stamps, card slips) — {"note","amount","currency","spent_at","category"}. Use the merchant as note; spent_at from the receipt date.
- currency: ISO code from the symbol/context (£→GBP, $→USD, R→ZAR if South African context); default GBP.
- A receipt is expenses, a bill not yet paid is finance_payments, a statement line can be either — direction decides.
- summary: one sentence saying what the document is.

Respond ONLY with JSON, no markdown fences:
{"summary":"...","tasks":[],"finance_payments":[],"finance_revenue":[],"expenses":[]}`;

    const system = mode === "finance" ? financeSystem : `You are the smart-capture engine inside a personal GTD (Getting Things Done) task manager.
The user pastes raw material — emails, WhatsApp messages, meeting notes, or screenshots of any of these — and you extract actionable tasks.

Today's date: ${today || new Date().toISOString().slice(0, 10)} (use it to resolve phrases like "by Friday", "end of month", "tomorrow").

The user's standing rules — follow these when assigning projects, priorities and people:
${rules || "(none provided)"}

Available contexts (choose the best fit or null): ${JSON.stringify(contexts || [])}
Existing projects (match by meaning; use the exact name given here, or null if none fits): ${JSON.stringify(projects || [])}
Areas of responsibility: ${JSON.stringify(areas || [])}
Known people: ${JSON.stringify(people || [])}

Extraction principles:
- Titles must be next physical actions starting with a verb ("Email Mark the revised SOW", not "Mark's email").
- One task per distinct commitment or request. Do not invent tasks that are not in the material.
- EXHAUSTIVENESS IS THE PRIORITY. Work through the material top to bottom and return every item, in the order they appear. Items near the end matter as much as the first ones.
- If the material is ALREADY a list of tasks (headings, bullets, "Owner:"/"Delegated to:" blocks, meeting-notes exports), return exactly ONE task per listed item. Preserve the given order.
- NEVER merge, dedupe, group or skip items because two of them look similar, cover the same system, or share an owner. Two similar items are two tasks.
- Do not summarise or truncate the list. If it is long, it is long.
- item_count: the number of distinct actionable items you identified in the material. Set this BEFORE writing the tasks array, and make the array that same length.
- due_date only when a deadline is stated or clearly implied; format YYYY-MM-DD; otherwise null.
- person / delegation: if the material states ownership EXPLICITLY (lines like "Owner:", "Delegated to:", "Assigned to:", "Action:"), honour it exactly and ignore other names in the prose.
  · "Delegated to: (none)", "(none)", "-", "n/a", or "Owner: you"/"Owner: me" all mean person = null and suggested_status is NOT "waiting" — this is the user's own task even if other people are named in the description.
  · A name only mentioned as a recipient, attendee or subject ("send it to Ingrid", "work with Mihail") is NOT a delegate. Do not set person from prose alone.
  · Only where no explicit marker exists may you infer from the prose that the user is waiting on someone.
- If the material shows the user is waiting on someone else, set suggested_status "waiting" and fill person.
- If it is a request TO the user, suggested_status "next" when a date exists, otherwise "inbox".
- priority: "high" only when urgency is explicit or implied by the rules; otherwise "normal".
- description: ONE short sentence, under 20 words. Do not restate the title, do not quote the source, do not repeat links or attribution.
- Extract EVERY task in the material, including ones near the end. Long lists are normal — never stop early or summarise the remainder.
- summary: one sentence describing what the material is.

Also extract money items when the material contains them:
- finance_payments: bills/invoices the user must PAY — {"name","amount","currency","due_date","recurring":"none|weekly|monthly|quarterly|annually","category"}
- finance_revenue: money the user expects to RECEIVE — {"name","client","amount","currency","expected_date","recurring"}
Only include amounts explicitly present. Empty arrays when none.

Respond ONLY with JSON, no markdown fences, exactly this shape:
{"summary":"...","item_count":0,"tasks":[{"title":"...","description":"...","due_date":null,"priority":"normal","context":null,"project":null,"area":null,"person":null,"suggested_status":"inbox"}],"finance_payments":[],"finance_revenue":[]}`;

    const content: unknown[] = [];
    for (const im of (images || []).slice(0, 4)) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: im.media_type || "image/png",
          data: im.data,
        },
      });
    }
    for (const doc of (documents || []).slice(0, 2)) {
      content.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: doc.data },
      });
    }
    if (text) content.push({ type: "text", text: String(text).slice(0, 24000) });
    if (!text) content.push({ type: "text", text: mode === "finance" ? "Extract the money items from the attached document(s)." : "Extract the tasks from the attached screenshot(s)." });

    const ask = async (sys: string, msgs: unknown[]) => {
      const rr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 16000,
          system: sys,
          messages: msgs,
        }),
      });
      const dd = await rr.json();
      const txt = (dd.content || [])
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text)
        .join("")
        .replace(/```json|```/g, "")
        .trim();
      return { ok: rr.ok, data: dd, text: txt };
    };

    const first = await ask(system, [{ role: "user", content }]);
    if (!first.ok) {
      return json({ error: first.data?.error?.message || "AI request failed" }, 502);
    }
    const d = first.data;
    const clean = first.text;

    const hitCeiling = d.stop_reason === "max_tokens";

    /* Second pass. A single extraction over a long list quietly drops items —
       and a dropped item is invisible to the user, which is the worst kind of
       failure here. So we show the model what it produced and ask only for
       what it missed. One extra call, bounded, and it cannot remove anything. */
    const sweep = async (got: Record<string, unknown>[]) => {
      const titles = got.map((t) => String(t.title || "")).filter(Boolean);
      const sweepSystem = `${system}

SECOND PASS. A first pass over this same material already produced the tasks listed below.
Your only job now is to find actionable items in the material that are NOT already covered by that list.
- Judge coverage by the underlying commitment, not by wording.
- Two similar-sounding items are BOTH needed if the material lists them separately.
- If nothing was missed, return {"item_count":0,"tasks":[],"finance_payments":[],"finance_revenue":[]}.
- Never repeat an item that is already covered. Never return an item that is not in the material.

Already extracted (${titles.length}):
${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
      try {
        const again = await ask(sweepSystem, [{ role: "user", content }]);
        if (!again.ok) return [];
        let extra: Record<string, unknown>[] = [];
        try {
          const p2 = JSON.parse(again.text);
          extra = Array.isArray(p2.tasks) ? p2.tasks : [];
        } catch {
          extra = extractArray(again.text, "tasks");
        }
        const seen = new Set(titles.map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()));
        return extra.filter((t) => {
          const k = String(t.title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (!k || seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      } catch {
        return [];
      }
    };

    const longMaterial = String(text || "").length > 1500 ||
      (images || []).length > 0 || (documents || []).length > 0;

    try {
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed.tasks)) throw new Error("no tasks array");
      if (hitCeiling) parsed.truncated = true;

      const declared = Number(parsed.item_count) || 0;
      const firstPass = parsed.tasks.length;
      // Sweep when the model itself says it found more than it wrote, or
      // whenever the material is long enough for silent drops to be likely.
      if (mode !== "finance" && !hitCeiling && firstPass > 0 &&
          (declared > firstPass || longMaterial)) {
        const extra = await sweep(parsed.tasks);
        parsed.swept = extra.length;   // always reported, so a silent no-op sweep is visible
        if (extra.length) parsed.tasks = parsed.tasks.concat(extra);
      }
      parsed.first_pass = firstPass;
      if (declared && parsed.tasks.length < declared) parsed.incomplete = true;
      return json(parsed);
    } catch (_e) {
      // Truncated or otherwise malformed: return whatever objects completed
      const tasks = extractArray(clean, "tasks");
      const payments = extractArray(clean, "finance_payments");
      const revenue = extractArray(clean, "finance_revenue");
      const expenses = extractArray(clean, "expenses");
      if (tasks.length || payments.length || revenue.length || expenses.length) {
        return json({
          summary: extractSummary(clean),
          tasks,
          finance_payments: payments,
          finance_revenue: revenue,
          expenses,
          truncated: true,
          recovered: true,
        });
      }
      return json({ error: "Could not read the AI response", raw: clean.slice(0, 2000) }, 502);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
