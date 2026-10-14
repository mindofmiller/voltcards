// Pure reconciliation: every loose physical copy gets exactly one outcome.
const norm = (v: unknown) => String(v || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g,'');
const collector = (v: unknown) => norm(v).replace(/^([a-z]*)0+(?=\d)/,'$1');
const tracking = (v: unknown) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g,'');
export function cardMatches(row: any, card: any) {
  const title = String(row.item_title || '').toLowerCase();
  if (!String(card.name || '').toLowerCase().split(/\s+/).filter(Boolean).every(w => norm(title).includes(norm(w)))) return false;
  for(const suffix of ['v','vmax','vstar','ex']) if(new RegExp('\\b'+suffix+'\\b','i').test(card.name||'')&&!new RegExp('\\b'+suffix+'\\b','i').test(title)) return false;
  const num = norm(String(card.number || '').split('/')[0]);
  if (num && collector(String(row.card_number || '').split('/')[0]) !== collector(num) &&
    !(title.match(/[a-z]*\d+/gi)||[]).some(n=>collector(n)===collector(num))) return false;
  const denominator = String(card.number || '').split('/')[1];
  const printed = String(row.card_number || '').includes('/') ? String(row.card_number) : (title.match(/[a-z]*\d+\/[a-z]*\d+/i)||[])[0];
  if(denominator && printed && printed.includes('/') && collector(printed.split('/')[1]) !== collector(denominator)) return false;
  const japanese = /japanese|japan|\bjpn\b|\bjp\b|[\u3040-\u30ff]/i.test(title);
  if (card.language === 'Japanese' && !japanese) return false;
  if (card.language === 'English' && japanese) return false;
  return true;
}
export function physicalInventory(photoReads: any[], extracted: any) {
  const cardPhotos=(photoReads||[]).filter((p: any)=>p.card_count>0);
  if(cardPhotos.some((p: any)=>!Number.isInteger(p.card_count)||p.card_count>64)) throw new Error('Invalid physical card count.');
  if(cardPhotos.length===1){
    const p=cardPhotos[0];
    extracted.inventory=Array.from({length:p.card_count},(_,i)=>{
      const row=p.reads.flatMap((r: any)=>r.inventory||[]).find((r: any)=>r.card_index===i+1)||{};
      return {...row,count:1};
    });
    // Detailed per-card reads are authoritative over guesses in the overview merge.
    extracted.uncertain=(extracted.uncertain||[]).filter((s: string)=>!/card|mew|rayquaza|darkrai|ditto|magneton/i.test(s));
  } else if(cardPhotos.length && extracted.inventory.reduce((n: number,r: any)=>n+(Number(r.count)||0),0)<Math.max(...cardPhotos.map((p: any)=>p.card_count))) {
    throw new Error('The identified count is below the visible card count. Nothing was saved; retry with each card photo separately.');
  }
  return extracted;
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
      if (!Number.isInteger(count) || count<1 || count>100) {
        issues.push('Needs a clearer photo: '+String(card.name || 'unidentified card')); continue;
      }
      const nameKnown=Boolean(card.name) && (card.name_confident === true || card.confident === true);
      const numberKnown=Boolean(card.number) && (card.number_confident === true || card.confident === true);
      const identity={...card,name:nameKnown?card.name:'Unidentified Pokémon card',number:numberKnown?card.number:null};
      const pool = nameKnown ? buys.filter(r=>eligible(r) && !used.has(r.id) && cardMatches(r,identity)) : [];
      // Without a read number, only package evidence can select a purchase safely.
      let candidates = pool.filter(r=>numberKnown || rank(r)>=3)
        .sort((a,b)=>rank(b)-rank(a) || String(a.txn_date).localeCompare(String(b.txn_date)) || a.id-b.id);
      if(!numberKnown && new Set(candidates.map(r=>collector(r.card_number)||norm(r.item_title))).size>1) candidates=[];
      // Only a label in THIS batch proves a received purchase belongs to these photos.
      const prior = candidates.filter(r=>r.received_at && exact.includes(r)).slice(0,count);
      prior.forEach(r=>used.add(r.id)); already_received += prior.length;
      const pending = candidates.filter(r=>!r.received_at).slice(0,count-prior.length);
      pending.forEach(r=>{ used.add(r.id); items.push({id:r.id,title:r.item_title,number:card.number,source:source(r)}); });
      const missing = count-prior.length-pending.length;
      // Multi-copy orders need allocation support; never manufacture an extra purchase for them.
      const multi = nameKnown && numberKnown && buys.some(r=>!r.received_at && Number(r.quantity||1)>1 && cardMatches(r,identity));
      if (missing && multi) issues.push(`${card.name}: ${missing} copy/copies need allocation to a multi-card purchase.`);
      else for(let i=0;i<missing;i++) items.push({title:`${identity.name}${identity.number?' '+identity.number:''}${card.language==='Japanese'?' Japanese':''}${card.set && nameKnown?' '+card.set:''}${!nameKnown||!numberKnown?' — identification pending':''}`,number:identity.number,source:'inventory',needs_identification:!nameKnown||!numberKnown});
      if(!nameKnown||!numberKnown) issues.push(`${identity.name}: checked in ${missing} physical copy/copies with ${!nameKnown?'identity':'collector number'} pending; no number was guessed.`);
      recon.push({card:identity.name,number:identity.number,present:count,matched:pending.length,already_received:prior.length,inventory_added:multi?0:missing,unresolved:multi?missing:0,identification_pending:!nameKnown||!numberKnown});
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
