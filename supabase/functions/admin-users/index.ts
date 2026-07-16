// Admin users — Supabase Edge Function
// Lets nominated administrators create accounts and reset passwords
// from the Rodney GTD console. Uses the service-role key, which is
// available automatically inside Edge Functions and never leaves here.
//
// Deploy: Supabase dashboard -> Edge Functions -> Deploy a new function
//         name: admin-users -> paste this file -> Deploy
// Secret: Edge Functions -> Secrets -> add ADMIN_EMAILS
//         value: comma-separated admin emails, e.g. r.julius@hotmail.co.uk

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
    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admins = (Deno.env.get("ADMIN_EMAILS") || "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    if (!admins.length) {
      return json({ error: "ADMIN_EMAILS secret is not set in Supabase" }, 500);
    }

    // Identify the caller from their JWT
    const ur = await fetch(`${supaUrl}/auth/v1/user`, {
      headers: {
        apikey: anon,
        Authorization: req.headers.get("Authorization") || "",
      },
    });
    if (!ur.ok) return json({ error: "Not signed in" }, 401);
    const caller = await ur.json();
    if (!admins.includes((caller.email || "").toLowerCase())) {
      return json(
        { error: "Not authorised — this account is not in ADMIN_EMAILS" },
        403,
      );
    }

    const { action, email, password, display_name, user_id } = await req.json();

    const svcHeaders = {
      apikey: svc,
      Authorization: "Bearer " + svc,
      "Content-Type": "application/json",
    };

    if (action === "create") {
      if (!email || !password) return json({ error: "Email and password required" }, 400);
      if (String(password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const r = await fetch(`${supaUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: svcHeaders,
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: { display_name: display_name || null },
        }),
      });
      const d = await r.json();
      if (!r.ok) return json({ error: d.msg || d.message || "Could not create the user" }, 400);
      // Set the display name on the auto-created profile
      if (display_name) {
        await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${d.id}`, {
          method: "PATCH",
          headers: { ...svcHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({ display_name }),
        }).catch(() => {});
      }
      return json({ ok: true, id: d.id, email: d.email });
    }

    if (action === "reset") {
      if (!user_id || !password) return json({ error: "User and new password required" }, 400);
      if (String(password).length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      const r = await fetch(`${supaUrl}/auth/v1/admin/users/${user_id}`, {
        method: "PUT",
        headers: svcHeaders,
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (!r.ok) return json({ error: d.msg || d.message || "Could not reset the password" }, 400);
      return json({ ok: true });
    }

    if (action === "archive" || action === "unarchive") {
      if (!user_id) return json({ error: "User required" }, 400);
      const r = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${user_id}`, {
        method: "PATCH",
        headers: { ...svcHeaders, Prefer: "return=minimal" },
        body: JSON.stringify({ archived: action === "archive" }),
      });
      if (!r.ok) return json({ error: "Could not update the person (run migration 003 first?)" }, 400);
      return json({ ok: true });
    }

    if (action === "delete") {
      if (!user_id) return json({ error: "User required" }, 400);
      if ((caller.id || "") === user_id) return json({ error: "You cannot delete your own account" }, 400);
      // Remove dependent data first (tasks either side, money history), then the account.
      await fetch(`${supaUrl}/rest/v1/transactions?or=(person_id.eq.${user_id},ledger_owner_id.eq.${user_id})`, {
        method: "DELETE", headers: { ...svcHeaders, Prefer: "return=minimal" },
      });
      await fetch(`${supaUrl}/rest/v1/cloud_tasks?or=(owner_id.eq.${user_id},assignee_id.eq.${user_id})`, {
        method: "DELETE", headers: { ...svcHeaders, Prefer: "return=minimal" },
      });
      const r = await fetch(`${supaUrl}/auth/v1/admin/users/${user_id}`, {
        method: "DELETE", headers: svcHeaders,
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return json({ error: d.msg || d.message || "Could not delete the user" }, 400);
      }
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
