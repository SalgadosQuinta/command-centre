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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { text, images, rules, contexts, projects, areas, people, today } =
      await req.json();

    if (!text && !(images && images.length)) {
      return json({ error: "Nothing to analyse" }, 400);
    }

    const key = Deno.env.get("ANTHROPIC_API_KEY");
    if (!key) {
      return json(
        { error: "ANTHROPIC_API_KEY secret is not set in Supabase" },
        500,
      );
    }

    const system = `You are the smart-capture engine inside a personal GTD (Getting Things Done) task manager.
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
    if (text) content.push({ type: "text", text: String(text).slice(0, 24000) });
    if (!text) content.push({ type: "text", text: "Extract the tasks from the attached screenshot(s)." });

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
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

    try {
      const parsed = JSON.parse(clean);
      if (!Array.isArray(parsed.tasks)) throw new Error("no tasks array");
      return json(parsed);
    } catch (_e) {
      return json({ error: "Could not read the AI response", raw: clean }, 502);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
