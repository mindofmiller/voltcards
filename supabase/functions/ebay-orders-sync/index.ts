import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const AUTH_TOKEN = Deno.env.get("EBAY_AUTH_TOKEN") || "";
const AUTH_TOKEN_2 = Deno.env.get("EBAY_AUTH_TOKEN_2") || "";
const APP_ID = Deno.env.get("EBAY_APP_ID") || "";
const CERT_ID = Deno.env.get("EBAY_CERT_ID") || "";
const DEV_ID = Deno.env.get("EBAY_DEV_ID") || "";
const USER_ID = "a4eecaeb-bfaf-4dd2-9dfb-31e4c28ca395";
const TZ = "America/Chicago";

const ACCOUNTS = [
  { name: "monopolyguy1", token: AUTH_TOKEN },
  { name: "voltcardsus", token: AUTH_TOKEN_2 },
].filter((a) => a.token);

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(+d)).replace(/&quot;/g, '\"').replace(/&apos;/g, "'");
function localDate(iso: string | null): string | null { if (!iso) return null; const d = new Date(iso); if (isNaN(d.getTime())) return iso.slice(0, 10); return d.toLocaleDateString("en-CA", { timeZone: TZ }); }

async function getItemImgTrading(token: string, itemId: string): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${esc(token)}</eBayAuthToken></RequesterCredentials>
  <ItemID>${esc(itemId)}</ItemID>
  <DetailLevel>ReturnAll</DetailLevel>
</GetItemRequest>`;
  const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-CALL-NAME": "GetItem", "X-EBAY-API-APP-NAME": APP_ID, "X-EBAY-API-DEV-NAME": DEV_ID, "X-EBAY-API-CERT-NAME": CERT_ID, "Content-Type": "text/xml" }, body });
  if (!r.ok) return null;
  const xml = await r.text();
  const pics = (xml.match(/<PictureURL>([^<]+)<\/PictureURL>/g) || []).map((m) => unesc(m.replace(/<\/?PictureURL>/g, "")));
  if (pics.length) return pics[0];
  const g = (xml.match(/<GalleryURL>([^<]+)<\/GalleryURL>/) || [])[1];
  return g ? unesc(g) : null;
}

let APP_TOKEN = ""; let APP_TOKEN_EXP = 0;
async function appToken() {
  if (APP_TOKEN && Date.now() < APP_TOKEN_EXP - 60000) return APP_TOKEN;
  const basic = btoa(`${APP_ID}:${CERT_ID}`);
  const r = await fetch("https://api.ebay.com/identity/v1/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + basic }, body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope") });
  const d = await r.json();
  APP_TOKEN = d.access_token || ""; APP_TOKEN_EXP = Date.now() + ((d.expires_in || 7200) * 1000);
  return APP_TOKEN;
}
async function getItemImg(token: string, itemId: string): Promise<string | null> {
  const r = await fetch("https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=" + encodeURIComponent(itemId), { headers: { "Authorization": "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US", "Content-Type": "application/json" } });
  if (!r.ok) return null;
  const d = await r.json();
  return d?.image?.imageUrl || d?.thumbnailImages?.[0]?.imageUrl || null;
}
async function searchImg(token: string, r: any): Promise<string | null> {
  const q = `${r.name || ""} ${(r.parallel || "").replace(/\(EN\)/gi, "")} ${r.card_number || ""} ${(r.set_name || "").replace(/\(EN\)/gi, "")}`.replace(/\s+/g, " ").trim() || (r.item_title || "");
  if (!q) return null;
  const rr = await fetch("https://api.ebay.com/buy/browse/v1/item_summary/search?limit=1&q=" + encodeURIComponent(q), { headers: { "Authorization": "Bearer " + token, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US", "Content-Type": "application/json" } });
  if (!rr.ok) return null;
  const d = await rr.json();
  const it = d?.itemSummaries?.[0];
  return it?.image?.imageUrl || it?.thumbnailImages?.[0]?.imageUrl || null;
}
async function enrichImages(svc: any, appTok: string, tradingTok: string, limit: number) {
  const { data } = await svc.from("card_transactions").select("id,ebay_item_id,item_title,name,set_name,card_number,parallel").eq("user_id", USER_ID).eq("type", "buy").is("image_url", null).order("txn_date", { ascending: false, nullsFirst: false }).limit(limit);
  let filled = 0;
  for (const r of (data || [])) {
    let img: string | null = null;
    if (r.ebay_item_id && tradingTok) { try { img = await getItemImgTrading(tradingTok, String(r.ebay_item_id)); } catch { /* */ } }
    if (!img && r.ebay_item_id && appTok) { try { img = await getItemImg(appTok, String(r.ebay_item_id)); } catch { /* */ } }
    if (!img && appTok) { try { img = await searchImg(appTok, r); } catch { /* */ } }
    if (img) { const { error } = await svc.from("card_transactions").update({ image_url: img }).eq("id", r.id); if (!error) filled++; }
  }
  return filled;
}

async function loadCardDim(svc: any): Promise<any[]> {
  let all: any[] = [];
  for (let off = 0; off < 60000; off += 1000) {
    const { data } = await svc.from("card_dim").select("game,set_name,card_number,name,parallel").range(off, off + 999);
    if (!data || !data.length) break;
    all = all.concat(data);
    if (data.length < 1000) break;
  }
  return all;
}

function normT(s: string) { return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim(); }
const PARSTOP2 = new Set(["one","piece","the","of","and","base","full","art","alt","alternate","holo","reverse","rare","illustration","special","secret","ultra","parallel","manga","gold","silver","foil","promo","promos","pokemon","english","japanese","single","pack","blister","exclusive","poke","ball","attack","double","prize"]);
const GAME_MARKERS: [string, RegExp][] = [
  ["magic", /\b(mtg|magic the gathering|wizards of the coast|planeswalker|wotc)\b/],
  ["yugioh", /(yu\W?gi\W?oh|konami)/],
  ["lorcana", /\blorcana\b/],
  ["digimon", /\bdigimon\b/],
  ["one-piece", /\bone piece\b/],
  ["pokemon", /pok[eé]mon/],
];
function detectGames(tl: string): Set<string> { const s = new Set<string>(); for (const [g, re] of GAME_MARKERS) if (re.test(tl)) s.add(g); return s; }
function cardNumFromTitle(title: string): string | null {
  let m = title.match(/\b(GG|TG)\s*0*(\d{1,3})\b/i); if (m) return String(parseInt(m[2]));
  m = title.match(/(\d{1,3})\s*\/\s*\d{2,3}/); if (m) return String(parseInt(m[1]));
  m = title.match(/\bOP\d{2}-(\d{2,3})\b/i); if (m) return String(parseInt(m[1]));
  m = title.match(/#\s*(\d{1,3})\b/); if (m) return String(parseInt(m[1]));
  m = title.match(/\bMEP\s*0*(\d{2,3})\b/i); if (m) return String(parseInt(m[1]));
  m = title.match(/\b(0\d{2})\b/); if (m) return String(parseInt(m[1]));
  m = title.match(/\bP-?(\d{2,3})[A-Za-z]?\b/i); if (m) return String(parseInt(m[1]));
  return null;
}
function parKeys(par: string): string[] { return normT(par).split(" ").filter((w) => w.length >= 4 && !PARSTOP2.has(w) && !/^\d+$/.test(w)); }
function matchCard(title: string, cards: any[]) {
  const t = normT(title);
  const tl = title.toLowerCase();
  const num = cardNumFromTitle(title);
  const jpTitle = /japanese|\bjp\b/i.test(title);
  const titleGames = detectGames(tl);
  let best: any = null, bestScore = 0;
  for (const c of cards) {
    const cn = c.card_number ? String(parseInt(String(c.card_number).replace(/\D/g, "") || "0")) : "";
    if (num && cn && num !== cn) continue;
    const cg = String(c.game || "").toLowerCase();
    if (titleGames.size && !titleGames.has(cg)) continue;
    let score = 0;
    if (num && cn && num === cn) score += 2;
    const name = normT(c.name);
    if (name && name.length > 2 && t.includes(name)) score += 2;
    const setk = normT(c.set_name).split(" ").filter((w) => w.length > 3);
    if (setk.some((w) => t.includes(w))) score += 1;
    const pk = parKeys(c.parallel || "");
    if (pk.length && pk.some((w) => t.includes(w))) score += 2;
    const jpSet = /japanese|\bjp\b/i.test(c.set_name);
    if (jpTitle !== jpSet) score -= 1;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const conf = bestScore >= 4 ? "high" : bestScore >= 3 ? "medium" : "none";
  return conf === "none" ? { card: null, conf } : { card: best, conf };
}

async function getOrdersPage(token: string, fromISO: string, toISO: string, page: number) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<GetOrdersRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${esc(token)}</eBayAuthToken></RequesterCredentials>
  <OrderRole>Buyer</OrderRole>
  <OrderStatus>All</OrderStatus>
  <CreateTimeFrom>${fromISO}</CreateTimeFrom>
  <CreateTimeTo>${toISO}</CreateTimeTo>
  <DetailLevel>ReturnAll</DetailLevel>
  <Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
</GetOrdersRequest>`;
  const r = await fetch("https://api.ebay.com/ws/api.dll", { method: "POST", headers: { "X-EBAY-API-SITEID": "0", "X-EBAY-API-COMPATIBILITY-LEVEL": "1193", "X-EBAY-API-CALL-NAME": "GetOrders", "X-EBAY-API-APP-NAME": APP_ID, "X-EBAY-API-DEV-NAME": DEV_ID, "X-EBAY-API-CERT-NAME": CERT_ID, "Content-Type": "text/xml" }, body });
  return await r.text();
}

function parseOrders(xml: string, account: string) {
  const out: any[] = [];
  const orders = xml.match(/<Order>[\s\S]*?<\/Order>/g) || [];
  for (const ob of orders) {
    const orderId = (ob.match(/<OrderID>([^<]+)<\/OrderID>/) || [])[1] || null;
    const created = (ob.match(/<CreatedTime>([^<]+)<\/CreatedTime>/) || [])[1] || null;
    const date = localDate(created);
    const seller = (ob.match(/<SellerUserID>([^<]+)<\/SellerUserID>/) || [])[1] || null;
    const orderShipped = (ob.match(/<ShippedTime>([^<]+)<\/ShippedTime>/) || [])[1] || null;
    const addrBlock = (ob.match(/<ShippingAddress>[\s\S]*?<\/ShippingAddress>/) || [])[0] || "";
    const shipToName = unesc((addrBlock.match(/<Name>([\s\S]*?)<\/Name>/) || [])[1] || "") || null;
    const shipState = (addrBlock.match(/<StateOrProvince>([^<]*)<\/StateOrProvince>/) || [])[1] || null;
    const shipCity = unesc((addrBlock.match(/<CityName>([^<]*)<\/CityName>/) || [])[1] || "") || null;
    const shipPostal = (addrBlock.match(/<PostalCode>([^<]*)<\/PostalCode>/) || [])[1] || null;
    const orderShip = parseFloat((ob.match(/<ShippingServiceSelected>[\s\S]*?<ShippingServiceCost[^>]*>([\d.]+)<\/ShippingServiceCost>/) || [])[1] || "0");
    const txns = ob.match(/<Transaction>[\s\S]*?<\/Transaction>/g) || [];
    let firstLine = true;
    for (const tb of txns) {
      const itemId = (tb.match(/<ItemID>([^<]+)<\/ItemID>/) || [])[1] || null;
      const title = unesc((tb.match(/<Title>([^<]*)<\/Title>/) || [])[1] || "");
      const qty = parseInt((tb.match(/<QuantityPurchased>(\d+)<\/QuantityPurchased>/) || [])[1] || "1");
      const price = parseFloat((tb.match(/<TransactionPrice[^>]*>([\d.]+)<\/TransactionPrice>/) || [])[1] || "0");
      const tax = parseFloat((tb.match(/<Taxes>[\s\S]*?<TotalTaxAmount[^>]*>([\d.]+)<\/TotalTaxAmount>/) || [])[1] || "0");
      const lineId = (tb.match(/<OrderLineItemID>([^<]+)<\/OrderLineItemID>/) || [])[1] || (itemId + "-" + (orderId || ""));
      const trkNum = unesc((tb.match(/<ShipmentTrackingNumber>([^<]+)<\/ShipmentTrackingNumber>/) || [])[1] || "") || null;
      const carrier = unesc((tb.match(/<ShippingCarrierUsed>([^<]+)<\/ShippingCarrierUsed>/) || [])[1] || "") || null;
      const txShipped = (tb.match(/<ShippedTime>([^<]+)<\/ShippedTime>/) || [])[1] || orderShipped;
      const itemBlock = (tb.match(/<Item>[\s\S]*?<\/Item>/) || [])[0] || "";
      const location = unesc((itemBlock.match(/<Location>([^<]*)<\/Location>/) || [])[1] || "") || null;
      const country = (itemBlock.match(/<Country>([^<]*)<\/Country>/) || [])[1] || null;
      if (itemId && title) {
        out.push({ orderId, date, itemId, title, qty, price, tax, shipping: firstLine ? orderShip : 0, lineId, tracking: trkNum, carrier, shipToName, shipState, shipCity, shipPostal, seller, shippedAt: txShipped, location, country, account });
        firstLine = false;
      }
    }
  }
  return out;
}

async function sync(days: number, imgLimit: number, trackingOnly = false) {
  if (!ACCOUNTS.length || !APP_ID) return { error: "missing eBay secrets (no account tokens set)" };
  if (trackingOnly) imgLimit = 0;
  const svc = createClient(SB_URL, SERVICE);
  const to = new Date();
  const from = new Date(to.getTime() - days * 864e5);
  const toISO = to.toISOString().replace(/\.\d+Z$/, ".000Z");
  const fromISO = from.toISOString().replace(/\.\d+Z$/, ".000Z");

  let lines: any[] = [];
  const acctErrors: any[] = [];
  const acctCounts: Record<string, number> = {};
  for (const acct of ACCOUNTS) {
    let acctLines = 0;
    for (let offset=0; offset<days; offset+=29) {
      const windowFrom = new Date(to.getTime()-Math.min(offset+29,days)*864e5).toISOString();
      const windowTo = new Date(to.getTime()-offset*864e5).toISOString();
      for (let page = 1; page <= 100; page++) {
        const xml = await getOrdersPage(acct.token, windowFrom, windowTo, page);
        const ack = (xml.match(/<Ack>([^<]+)<\/Ack>/) || [])[1] || "";
        if (!["Success","Warning"].includes(ack)) { acctErrors.push({ account: acct.name, error: unesc((xml.match(/<LongMessage>([^<]+)<\/LongMessage>/) || [])[1] || "unknown") }); break; }
        const parsed = parseOrders(xml, acct.name);
        const fresh = parsed.filter(ln=>!lines.some(x=>x.account===ln.account && x.lineId===ln.lineId));
        lines = lines.concat(fresh); acctLines += fresh.length;
        const more = (xml.match(/<HasMoreOrders>([^<]+)<\/HasMoreOrders>/) || [])[1];
        if (more !== "true") break;
        if (page===100) throw new Error("eBay purchase pagination limit reached");
      }
      if (acctErrors.some(e=>e.account===acct.name)) break;
    }
    acctCounts[acct.name] = acctLines;
  }

  // Load ALL existing buys (paginated) — a single select is capped at 1000 by PostgREST, which made
  // dedup/enrich/tracking-backfill silently skip every order beyond the first 1000 (we have 2000+).
  let ex: any[] = [];
  for (let off = 0; off < 100000; off += 1000) {
    const { data } = await svc.from("card_transactions").select("id,ebay_item_id,ebay_order_id,game,set_name,card_number,parallel,txn_date,price,tracking_number").eq("user_id", USER_ID).eq("type", "buy").range(off, off + 999);
    if (!data || !data.length) break;
    ex = ex.concat(data);
    if (data.length < 1000) break;
  }
  const seenItem = new Set<string>(), seenOrder = new Set<string>(), seenKey = new Set<string>(), trackedKey = new Set<string>();
  for (const r of ex) {
    if (r.ebay_item_id) seenItem.add(String(r.ebay_item_id));
    if (r.ebay_order_id) seenOrder.add(String(r.ebay_order_id));
    seenKey.add([r.game, r.set_name, r.card_number, r.parallel, r.txn_date, r.price].join("¦"));
    if (r.tracking_number) { if (r.ebay_item_id) trackedKey.add("i:" + r.ebay_item_id); if (r.ebay_order_id) trackedKey.add("o:" + r.ebay_order_id); }
  }

  // trackingOnly mode skips the 60k-row card_dim load and all per-order enrich/insert writes;
  // it exists so a FULL 90-day window can run daily without hitting WORKER_RESOURCE_LIMIT,
  // catching tracking numbers sellers add late (slow USPS / international) that fall outside
  // the hourly 14-day full sync.
  const cardList = trackingOnly ? [] : await loadCardDim(svc);

  let inserted = 0, skipped = 0, unmatched = 0;
  const rows: any[] = [];
  const trackBumps: any[] = [];
  const trackUpdates: any[] = [];
  const enrichUpdates: any[] = [];
  for (const ln of lines) {
    const isDup = seenItem.has(String(ln.itemId)) || (ln.orderId && seenOrder.has(String(ln.orderId)));
    if (isDup) {
      if (!trackingOnly) {
        enrichUpdates.push({ itemId: ln.itemId, orderId: ln.orderId, txnDate: ln.date, shippedAt: ln.shippedAt, location: ln.location, country: ln.country, qty: ln.qty, account: ln.account, shipToName: ln.shipToName, shipState: ln.shipState, shipCity: ln.shipCity, shipPostal: ln.shipPostal, seller: ln.seller, shipping: ln.shipping, tax: ln.tax });
      }
      skipped++;
      if (ln.tracking && !trackedKey.has("i:" + ln.itemId) && !(ln.orderId && trackedKey.has("o:" + ln.orderId))) {
        trackUpdates.push({ itemId: ln.itemId, orderId: ln.orderId, tracking: ln.tracking, carrier: ln.carrier, shipToName: ln.shipToName, seller: ln.seller });
        if (ln.itemId) trackedKey.add("i:" + ln.itemId);
        if (ln.orderId) trackedKey.add("o:" + ln.orderId);
      }
      continue;
    }
    if (trackingOnly) continue;
    const mm = matchCard(ln.title, cardList);
    const c = mm.card;
    if (c) {
      const key = [c.game, c.set_name, c.card_number, c.parallel, ln.date, ln.price].join("¦");
      if (seenKey.has(key)) { skipped++; continue; }
    } else unmatched++;
    rows.push({
      user_id: USER_ID, type: "buy", txn_date: ln.date, price: ln.price, item_title: ln.title, quantity: ln.qty,
      shipping_cost: ln.shipping, tax: ln.tax,
      ebay_item_id: ln.itemId, ebay_order_id: ln.orderId, email_id: "ebayapi-" + ln.lineId, ebay_account: ln.account,
      tracking_number: ln.tracking, shipping_carrier: ln.carrier, ship_to_name: ln.shipToName,
      ship_to_state: ln.shipState, ship_to_city: ln.shipCity, ship_to_postal: ln.shipPostal, seller: ln.seller,
      shipped_at: ln.shippedAt, ship_from_location: ln.location, ship_from_country: ln.country,
      game: c?.game ?? null, set_name: c?.set_name ?? null, card_number: c?.card_number ?? null, parallel: c?.parallel ?? null,
      matched: !!c, confidence: mm.conf,
    });
    if (c && (mm.conf === "high" || mm.conf === "medium")) trackBumps.push({ c, qty: ln.qty });
    seenItem.add(String(ln.itemId));
  }

  if (rows.length) {
    const { error } = await svc.from("card_transactions").upsert(rows, { onConflict: "email_id", ignoreDuplicates: true });
    if (error) return { error: "insert failed: " + error.message, found: lines.length };
    inserted = rows.length;
    for (const b of trackBumps) await svc.rpc("bump_tracking", { _uid: USER_ID, _game: b.c.game, _set: b.c.set_name, _num: b.c.card_number, _par: b.c.parallel, _qty: b.qty });
  }

  let trackingUpdated = 0;
  for (const u of trackUpdates) {
    let q = svc.from("card_transactions").update({ tracking_number: u.tracking, shipping_carrier: u.carrier, ship_to_name: u.shipToName, seller: u.seller }).eq("user_id", USER_ID).eq("type", "buy").is("tracking_number", null);
    if (u.itemId) q = q.eq("ebay_item_id", u.itemId);
    if (u.orderId) q = q.eq("ebay_order_id", u.orderId);
    const { error } = await q; if (!error) trackingUpdated++;
  }

  let enriched = 0, nameBackfilled = 0, dateFixed = 0, addrFilled = 0;
  for (const u of enrichUpdates) {
    const patch: Record<string, unknown> = {};
    if (u.shippedAt) patch.shipped_at = u.shippedAt;
    if (u.location) patch.ship_from_location = u.location;
    if (u.country) patch.ship_from_country = u.country;
    if (u.qty != null) patch.quantity = u.qty;
    if (u.account) patch.ebay_account = u.account;
    if (u.shipping != null) patch.shipping_cost = u.shipping;
    if (u.tax != null) patch.tax = u.tax;
    if (u.txnDate) patch.txn_date = u.txnDate;
    if (u.shipState) patch.ship_to_state = u.shipState;
    if (u.shipCity) patch.ship_to_city = u.shipCity;
    if (u.shipPostal) patch.ship_to_postal = u.shipPostal;
    if (Object.keys(patch).length) {
      let q = svc.from("card_transactions").update(patch).eq("user_id", USER_ID).eq("type", "buy");
      if (u.itemId) q = q.eq("ebay_item_id", u.itemId); else if (u.orderId) q = q.eq("ebay_order_id", u.orderId);
      const { error } = await q; if (!error) { enriched++; if (u.txnDate) dateFixed++; if (u.shipState) addrFilled++; }
    }
    if (u.shipToName) {
      let q2 = svc.from("card_transactions").update({ ship_to_name: u.shipToName }).eq("user_id", USER_ID).eq("type", "buy").is("ship_to_name", null);
      if (u.itemId) q2 = q2.eq("ebay_item_id", u.itemId); else if (u.orderId) q2 = q2.eq("ebay_order_id", u.orderId);
      const { error: e2, count } = await q2; if (!e2 && count) nameBackfilled += count;
    }
    if (u.seller) {
      let q3 = svc.from("card_transactions").update({ seller: u.seller }).eq("user_id", USER_ID).eq("type", "buy").is("seller", null);
      if (u.itemId) q3 = q3.eq("ebay_item_id", u.itemId); else if (u.orderId) q3 = q3.eq("ebay_order_id", u.orderId);
      await q3;
    }
  }

  let imagesFilled = 0;
  if (imgLimit > 0) {
    let tk = "";
    try { tk = await appToken(); } catch { /* */ }
    const tradingTok = ACCOUNTS[0]?.token || "";
    try { imagesFilled = await enrichImages(svc, tk, tradingTok, imgLimit); } catch { /* skip */ }
  }

  return { ok: true, window_days: days, tracking_only: trackingOnly, tz: TZ, accounts: ACCOUNTS.map((a) => a.name), account_lines: acctCounts, account_errors: acctErrors, order_lines: lines.length, existing_loaded: ex.length, card_dim_loaded: cardList.length, inserted, skipped, unmatched, tracking_backfilled: trackingUpdated, enriched, addr_filled: addrFilled, date_fixed: dateFixed, name_backfilled: nameBackfilled, images_filled: imagesFilled };
}

Deno.serve(async (req) => {
  try {
    const svc = createClient(SB_URL, SERVICE);
    const { data: cfg } = await svc.from("app_config").select("value").eq("key", "poll_secret").limit(1);
    const secret = cfg?.[0]?.value;
    if (!secret || req.headers.get("x-poll-secret") !== secret) return json({ error: "forbidden" }, 403);
    let days = 3, imgLimit = 40, trackingOnly = false;
    try { const b = await req.json(); if (b && b.days) days = Math.min(89, Math.max(1, Number(b.days))); if (b && b.imgLimit != null) imgLimit = Math.min(300, Math.max(0, Number(b.imgLimit))); if (b && b.trackingOnly) trackingOnly = !!b.trackingOnly; } catch { /* */ }
    return json(await sync(days, imgLimit, trackingOnly));
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

