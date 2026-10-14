// Pure reconciliation: every loose physical copy gets exactly one outcome.
const norm = (v: unknown) => String(v || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
const tracking = (v: unknown) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
export function cardMatches(row: any, card: any) {
  const title = String(row.item_title || '').toLowerCase();
  if (!String(card.name || '').toLowerCase().split(/\s+/).filter(Boolean).every(w => norm(title).includes(norm(w)))) return false;
  const num = norm(String(card.number || '').split('/')[0]);
  if (num && norm(String(row.card_number || '').split('/')[0]) !== num &&
    !new RegExp('(^|[^a-z0-9])'+num+'([^a-z0-9]|$)','i').test(title)) return false;
  const denominator = String(card.number || '').split('/')[1];
  const printed = String(row.card_number || '').includes('/') ? String(row.card_number) : (title.match(/[a-z]*\d+\/[a-z]*\d+/i)||[])[0];
  if(denominator && printed && printed.includes('/') && norm(printed.split('/')[1]) !== norm(denominator)) return false;
  const japanese = /japanese|japan|\bjpn\b|\bjp\b|[\u3040-\u30ff]/i.test(title);
  if (card.language === 'Japanese' && !japanese) return false;
  if (card.language === 'English' && japanese) return false;
  return true;
}
export function senderScore(row: any, pkg: any) {
  const seller = norm(row.seller), name = norm(pkg.sender_name);
  const location = norm(row.ship_from_location), address = norm(pkg.sender_address);
  let score = 0;
  if (seller.length > 3 && name.length > 3 && (seller === name || name.includes(seller))) score += 4;
  if (location.length > 5 && address.includes(location)) score += 4;
  if (pkg.sender_postal && location.includes(norm(pkg.sender_postal))) score += 3;
  if (pkg.sender_city && norm(pkg.sender_city).length > 3 && location.includes(norm(pkg.sender_city))) score += 2;
  if (pkg.sender_state && String(row.ship_from_location||'').toLowerCase().split(/[^a-z]+/).includes(String(pkg.sender_state).toLowerCase())) score += 1;
  return score;
}
export function reconcile(buys: any[], extracted: any, barcodes: string[]) {
  const packages = Array.isArray(extracted.packages) ? extracted.packages : [];
  const inventory = Array.isArray(extracted.inventory) ? extracted.inventory : [];
  const issues: string[] = Array.isArray(extracted.uncertain) ? extracted.uncertain.map(String) : [];
  const used = new Set<number>(); const items: any[] = []; const recon: any[] = [];
  const labels = new Set([...barcodes,...packages.map((p: any)=>p.tracking)].map(tracking).filter(Boolean));
  const exact = buys.filter(r=>labels.has(tracking(r.tracking_number)));
  const eligible = (r: any) => !r.canceled && !r.flagged_defective && Number(r.quantity || 1) === 1;
  const source = (r: any) => exact.includes(r) ? 'tracking' : packages.some((p: any)=>senderScore(r,p)>=3) ? 'sender' : 'card';
  const rank = (r: any) => exact.includes(r) ? 100 : Math.max(0,...packages.map((p: any)=>senderScore(r,p)));
  let already_received = 0;
  if (inventory.length) {
    for (const card of inventory) {
      const count = Number(card.count);
      if (!card.name || !card.number || card.confident !== true || !Number.isInteger(count) || count<1 || count>100) {
        issues.push('Needs a clearer photo: '+String(card.name || 'unidentified card')); continue;
      }
      const candidates = buys.filter(r=>eligible(r) && !used.has(r.id) && cardMatches(r,card))
        .sort((a,b)=>rank(b)-rank(a) || String(a.txn_date).localeCompare(String(b.txn_date)) || a.id-b.id);
      // Only a label in THIS batch proves a received purchase belongs to these photos.
      const prior = candidates.filter(r=>r.received_at && exact.includes(r)).slice(0,count);
      prior.forEach(r=>used.add(r.id)); already_received += prior.length;
      const pending = candidates.filter(r=>!r.received_at).slice(0,count-prior.length);
      pending.forEach(r=>{ used.add(r.id); items.push({id:r.id,title:r.item_title,number:card.number,source:source(r)}); });
      const missing = count-prior.length-pending.length;
      // Multi-copy orders need allocation support; never manufacture an extra purchase for them.
      const multi = buys.some(r=>!r.received_at && Number(r.quantity||1)>1 && cardMatches(r,card));
      if (missing && multi) issues.push(`${card.name}: ${missing} copy/copies need allocation to a multi-card purchase.`);
      else for(let i=0;i<missing;i++) items.push({title:`${card.name} ${card.number}${card.language==='Japanese'?' Japanese':''}${card.set?' '+card.set:''}`,number:card.number,source:'inventory'});
      recon.push({card:card.name,number:card.number,present:count,matched:pending.length,already_received:prior.length,inventory_added:multi?0:missing,unresolved:multi?missing:0});
    }
    // Labels cannot add extra cards beyond the photographed inventory.
    const excess=exact.filter(r=>!r.received_at && !used.has(r.id));
    if(excess.length) issues.push(`${excess.length} purchase(s) matched labels but were not included in the visible card counts; left unreceived.`);
  } else {
    // Package-only uploads: exact tracking, then uniquely supported sender identity/location.
    const selected = new Map<number,any>(); exact.filter(eligible).forEach(r=>selected.set(r.id,r));
    for (const pkg of packages) {
      if (buys.some(r=>tracking(pkg.tracking) && tracking(r.tracking_number)===tracking(pkg.tracking))) continue;
      const hits=buys.filter(r=>eligible(r) && !r.received_at && senderScore(r,pkg)>=3);
      if(hits.length===1) selected.set(hits[0].id,hits[0]);
      else issues.push(`Could not uniquely match package from ${pkg.sender_name || pkg.sender_address || 'unreadable sender'}. Include a photo of its cards.`);
    }
    selected.forEach(r=>{ if(r.received_at) already_received++; else items.push({id:r.id,title:r.item_title,number:r.card_number,source:source(r)}); });
    for(const label of labels) if(!exact.some(r=>tracking(r.tracking_number)===label)) issues.push(`Tracking ${label} had no exact purchase match; sender fallback was attempted.`);
  }
  if(items.length>200) throw new Error('Upload at most 200 physical cards per batch.');
  return {items,recon,already_received,issues,physical_count:recon.reduce((n,r)=>n+r.present,0)};
}
