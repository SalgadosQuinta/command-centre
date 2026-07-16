// Notify — sends a web push notification to another user of the platform.
// Deploy as Edge Function name: notify
// Secrets required: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com)
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
    const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:admin@example.com";
    if (!pub || !priv) return json({ error: "VAPID secrets not set" }, 500);
    webpush.setVapidDetails(subject, pub, priv);

    const ur = await fetch(`${supaUrl}/auth/v1/user`, { headers: { apikey: anon, Authorization: req.headers.get("Authorization") || "" } });
    if (!ur.ok) return json({ error: "Not signed in" }, 401);

    const { to_user_id, title, body, url } = await req.json();
    if (!to_user_id || !title) return json({ error: "to_user_id and title required" }, 400);

    const sr = await fetch(`${supaUrl}/rest/v1/push_subscriptions?user_id=eq.${to_user_id}&select=id,subscription`, {
      headers: { apikey: svc, Authorization: "Bearer " + svc },
    });
    const subs = await sr.json();
    let sent = 0;
    for (const row of subs || []) {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({ title, body: body || "", url: url || "./" }));
        sent++;
      } catch (e) {
        // remove dead subscriptions
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          await fetch(`${supaUrl}/rest/v1/push_subscriptions?id=eq.${row.id}`, { method: "DELETE", headers: { apikey: svc, Authorization: "Bearer " + svc, Prefer: "return=minimal" } });
        }
      }
    }
    return json({ ok: true, sent });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
