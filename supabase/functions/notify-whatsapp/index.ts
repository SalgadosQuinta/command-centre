// notify-whatsapp — sends a WhatsApp message via CallMeBot (personal-use gateway).
// Each recipient opts in once with CallMeBot and gets their own API key:
//   1. Add +34 644 44 21 48 to contacts, send "I allow callmebot to send me messages" on WhatsApp
//   2. CallMeBot replies with a personal apikey
//   3. Enter their phone (with country code) + apikey in the GTD People view
// Deploy from the Supabase dashboard: Edge Functions -> New function -> notify-whatsapp
// (JWT verification left ON — only signed-in family members can call it.)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { phone, apikey, text } = await req.json();
    if (!phone || !apikey || !text) {
      return new Response(JSON.stringify({ error: "phone, apikey and text are required" }),
        { status: 400, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const url = "https://api.callmebot.com/whatsapp.php?phone=" + encodeURIComponent(phone) +
      "&apikey=" + encodeURIComponent(apikey) +
      "&text=" + encodeURIComponent(String(text).slice(0, 500));
    const r = await fetch(url);
    const body = await r.text();
    const ok = r.ok && !/error|invalid/i.test(body);
    return new Response(JSON.stringify({ ok, status: r.status, detail: body.slice(0, 200) }),
      { status: ok ? 200 : 502, headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
});
