import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Volt watchlist uses the verified voltlabsllc connection.
const AUTH_TOKEN = Deno.env.get("EBAY_AUTH_TOKEN_2") || "";
const APP_ID = Deno.env.get("EBAY_APP_ID") || "";
const CERT_ID = Deno.env.get("EBAY_CERT_ID") || "";
const DEV_ID = Deno.env.get("EBAY_DEV_ID") || "";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type, x-client-info", "access-control-allow-methods": "POST, OPTIONS" };
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '\"').replace(/&apos;/g, "'");

const TRADING_HEADERS = (call: string) => ({
  "X-EBAY-API-SITEID": "0",
  "X-EBAY-API-COMPATIBILITY-LEVEL": "1193",
  "X-EBAY-API-CALL-NAME": call,
  "X-EBAY-API-APP-NAME": APP_ID,
  "X-EBAY-API-DEV-NAME": DEV_ID,
  "X-EBAY-API-CERT-NAME": CERT_ID,
  "Content-Type": "text/xml",
});

function legacyId(raw: string): string | null {
  if (!raw) return null;
  if (raw.includes("|")) { const p = raw.split("|"); return (p[1] || "").replace(/\D/g, "") || null; }
  const d = raw.replace(/\D/g, "");
  return d || null;
}

async function watchCall(action: "add" | "remove", itemId: string) {
  const call = action === "remove" ? "RemoveFromWatchList" : "AddToWatchList";
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${call}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${esc(AUTH_TOKEN)}</eBayAuthToken></RequesterCredentials>
  <ItemID>${esc(itemId)}</ItemID>
</${call}Request>`;
  const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: TRADING_HEADERS(call), body });
  const xml = await r.text();
  const ack = (xml.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || "";
  const count = (xml.match(/<WatchListCount>(\d+)<\/WatchListCount>/) || [])[1] || null;
  const max = (xml.match(/<WatchListMaximum>(\d+)<\/WatchListMaximum>/) || [])[1] || null;
  const msg = unesc((xml.match(/<LongMessage>([^<]+)<\/LongMessage>/) || [])[1] || "");
  const ok = ack === "Success" || ack === "Warning";
  return { ok, ack, count: count ? Number(count) : null, max: max ? Number(max) : null, message: msg || null };
}

async function watchListIds() {
  let ids: string[] = [];
  for (let page = 1; page <= 5; page++) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBayBuyingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${esc(AUTH_TOKEN)}</eBayAuthToken></RequesterCredentials>
  <WatchList><Include>true</Include><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination></WatchList>
</GetMyeBayBuyingRequest>`;
    const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: TRADING_HEADERS("GetMyeBayBuying"), body });
    const xml = await r.text();
    const ack=(xml.match(/<Ack>([^<]+)<\/Ack>/)||[])[1];
    if(!["Success","Warning"].includes(ack||"")) throw new Error(unesc((xml.match(/<LongMessage>([^<]+)<\/LongMessage>/)||[])[1]||"eBay watchlist request failed"));
    const wl = (xml.match(/<WatchList>[\s\S]*?<\/WatchList>/) || [])[0] || "";
    const pageIds = (wl.match(/<ItemID>(\d+)<\/ItemID>/g) || []).map((m) => m.replace(/\D/g, ""));
    ids = ids.concat(pageIds);
    const total = Number((wl.match(/<TotalNumberOfPages>(\d+)<\/TotalNumberOfPages>/) || [])[1] || "1");
    if (page >= total) break;
  }
  return [...new Set(ids)];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (!AUTH_TOKEN || !APP_ID) return json({ error: "missing eBay secrets" }, 500);
    const authz = req.headers.get("Authorization") || "";
    const svc = createClient(SB_URL, SERVICE);
    const { data: u } = await svc.auth.getUser(authz.replace(/^Bearer\s+/i, ""));
    if (!u || !u.user) return json({ error: "unauthorized" }, 401);

    const b = await req.json().catch(() => ({}));
    const action = b?.action || "add";
    if (action === "list") { const items = await watchListIds(); return json({ ok: true, items }); }
    const id = legacyId(String(b?.item_id || ""));
    if (!id) return json({ error: "missing or invalid item_id" }, 400);
    const res = await watchCall(action === "remove" ? "remove" : "add", id);
    return json(res, res.ok ? 200 : 502);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

