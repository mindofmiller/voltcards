import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });

// verify_jwt=true -> only an authenticated Volt Cards user can reach this.
// Proxies to the secret-gated ebay-orders-sync so a fresh eBay GetOrders pull runs on demand.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const svc = createClient(SB_URL, SERVICE);
    const {data: auth} = await svc.auth.getUser((req.headers.get("Authorization") || "").replace(/^Bearer\s+/i,""));
    if(auth?.user?.id !== "a4eecaeb-bfaf-4dd2-9dfb-31e4c28ca395") return json({error:"forbidden"},403);
    const { data: cfg } = await svc.from("app_config").select("value").eq("key", "poll_secret").limit(1);
    const secret = cfg?.[0]?.value || "";
    let days = 3;
    try { const b = await req.json(); if (b && b.days) days = Math.min(90, Math.max(1, Number(b.days))); } catch { /* default */ }
    const r = await fetch(SB_URL + "/functions/v1/ebay-orders-sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + SERVICE,
        "apikey": SERVICE,
        "x-poll-secret": secret,
      },
      body: JSON.stringify({ days }),
    });
    const d = await r.json();
    return json({ ok: r.ok && !d.error, sync: d }, r.ok && !d.error ? 200 : 502);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

