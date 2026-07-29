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
- due_date only when a deadline is stated or clearly implied; format YYYY-MM-DD; otherwise null.
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
{"summary":"...","tasks":[{"title":"...","description":"...","due_date":null,"priority":"normal","context":null,"project":null,"area":null,"person":null,"suggested_status":"inbox"}],"finance_payments":[],"finance_revenue":[]}`;

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

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16000,
        system,
        messages: [{ role: "user", content }],
      }),
    });

    const d = await r.json();
    if (!r.ok) {
      return json({ error: d?.error?.message || "AI request failed" }, 502);
    }

    const raw = (d.content || [])
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text: string }) => c.text)
      .join("");
    const clean = raw.replace(/```json|```/g, "").trim();

    const hitCeiling = d.stop_reason === "max_tokens";

    try {
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed.tasks)) throw new Error("no tasks array");
      if (hitCeiling) parsed.truncated = true;
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
