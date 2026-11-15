import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { escapeXml as esc, pick, checkAck, parseSellerOrders, canShip } from './orders.ts';

const OWNER = 'a4eecaeb-bfaf-4dd2-9dfb-31e4c28ca395';
const env = (k: string) => Deno.env.get(k) || '';
const svc = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'));
const cors = {'Access-Control-Allow-Origin':'https://voltcards.us','Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'};
const json = (data: unknown, status=200) => new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}});
const checked = (r: any) => {if(r.error) throw new Error(r.error.message);return r.data;};

async function trading(call: string, content: string) {
  const token=env('EBAY_AUTH_TOKEN_2');
  if(!token) throw new Error('Volt eBay seller token is missing');
  const r=await fetch('https://api.ebay.com/ws/api.dll',{method:'POST',headers:{'Content-Type':'text/xml','X-EBAY-API-SITEID':'0','X-EBAY-API-COMPATIBILITY-LEVEL':'1193','X-EBAY-API-CALL-NAME':call,'X-EBAY-API-APP-NAME':env('EBAY_APP_ID'),'X-EBAY-API-CERT-NAME':env('EBAY_CERT_ID'),'X-EBAY-API-DEV-NAME':env('EBAY_DEV_ID')},body:`<?xml version="1.0" encoding="utf-8"?><${call}Request xmlns="urn:ebay:apis:eBLBaseComponents"><RequesterCredentials><eBayAuthToken>${esc(token)}</eBayAuthToken></RequesterCredentials>${content}</${call}Request>`});
  if(!r.ok) throw new Error('eBay returned HTTP '+r.status);
  const xml=await r.text();checkAck(xml);return xml;
}
async function sync() {
  const seller=await trading('GetUser','<DetailLevel>ReturnAll</DetailLevel>');
  if(pick(seller,'UserID').toLowerCase()!=='voltcardsus') throw new Error('Connected eBay account is not voltcardsus');
  const from=new Date(Date.now()-89*864e5).toISOString();
  const to=new Date().toISOString();let count=0;
  for(let page=1;page<=100;page++){
    const xml=await trading('GetOrders',`<OrderRole>Seller</OrderRole><OrderStatus>All</OrderStatus><ModTimeFrom>${from}</ModTimeFrom><ModTimeTo>${to}</ModTimeTo><DetailLevel>ReturnAll</DetailLevel><Pagination><EntriesPerPage>100</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>`);
    const rows=parseSellerOrders(xml,OWNER);
    if(rows.length) checked(await svc.from('shipping_orders').upsert(rows,{onConflict:'id'}));
    count+=rows.length;
    if(pick(xml,'HasMoreOrders')!=='true') return count;
  }
  throw new Error('eBay pagination limit reached; sync incomplete');
}
async function order(id: string) {
  const row=checked(await svc.from('shipping_orders').select('*').eq('id',id).eq('user_id',OWNER).single());
  if(!row) throw new Error('Order not found');return row;
}
async function markShipped(id: string) {
  let row=await order(id);
  // Re-read this specific order before changing eBay: catch refunds/cancellations.
  const xml=await trading('GetOrders',`<OrderIDArray><OrderID>${esc(id)}</OrderID></OrderIDArray><DetailLevel>ReturnAll</DetailLevel>`);
  const fresh=parseSellerOrders(xml,OWNER).find(r=>r.id===id);
  if(!fresh) throw new Error('Order no longer available on eBay');
  checked(await svc.from('shipping_orders').upsert(fresh));row=await order(id);
  if(!canShip(row)) throw new Error('A paid, uncanceled order and valid carrier/tracking are required');
  if(!row.ebay_shipped_at){
    await trading('CompleteSale',`<OrderID>${esc(id)}</OrderID><Shipped>true</Shipped><Shipment><ShipmentTrackingDetails><ShipmentTrackingNumber>${esc(row.tracking_number)}</ShipmentTrackingNumber><ShippingCarrierUsed>${esc(row.carrier)}</ShippingCarrierUsed></ShipmentTrackingDetails></Shipment>`);
  }
  const now=new Date().toISOString();
  checked(await svc.from('shipping_orders').update({handed_off_at:row.handed_off_at || now,ebay_shipped_at:row.ebay_shipped_at || now,updated_at:now}).eq('id',id).eq('user_id',OWNER));
  return {ok:true};
}
async function tracking() {
  if(!env('EASYPOST_API_KEY')) return {checked:0,error:'EasyPost tracking key is missing'};
  const rows=checked(await svc.from('shipping_orders').select('*').eq('user_id',OWNER).not('tracking_number','is',null).or('delivery_status.is.null,delivery_status.not.in.(delivered,return_to_sender,cancelled)'));
  let count=0;const errors: string[]=[];
  for(const row of rows.slice(0,100)){
    try{
      if(/^ESUS/i.test(row.tracking_number)) continue;
      const url='https://api.easypost.com/v2/trackers'+(row.tracker_id?'/'+encodeURIComponent(row.tracker_id):'');
      const r=await fetch(url,{method:row.tracker_id?'GET':'POST',headers:{Authorization:'Basic '+btoa(env('EASYPOST_API_KEY')+':'),'Content-Type':'application/json'},...(row.tracker_id?{}:{body:JSON.stringify({tracker:{tracking_code:row.tracking_number,carrier:row.carrier}})})});
      const d=await r.json();if(!r.ok) throw new Error('Tracking provider HTTP '+r.status);
      checked(await svc.from('shipping_orders').update({tracker_id:d.id,delivery_status:d.status || 'unknown',delivery_checked_at:new Date().toISOString()}).eq('id',row.id));count++;
    }catch(e){errors.push(row.id+': '+String(e));}
  }
  return {checked:count,errors};
}
async function emailLabel(id: string) {
  const row=await order(id);
  if(!row.paid_at || row.canceled || row.handed_off_at) return {skipped:true};
  const label=checked(await svc.from('shipping_labels').select('*').eq('order_id',id).maybeSingle());
  if(!label || label.emailed_at) return {skipped:true};
  if(!env('RESEND_API_KEY') || !env('RESEND_FROM')) throw new Error('Shipping email sender is not configured');
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env('RESEND_API_KEY'),'Content-Type':'application/json','Idempotency-Key':'volt-label-'+id+'-'+label.created_at},body:JSON.stringify({from:env('RESEND_FROM'),to:['mallardpointdev@gmail.com'],cc:['voltcardsus@gmail.com'],subject:'Volt · Ready to ship · '+id,text:`Ship from Brett Miller, 221 Riss Dr, Normal, IL 61761-3230.\n\n${row.items.map((i:any)=>`${i.quantity} × ${i.title}`).join('\n')}\n\nTracking: ${row.carrier} ${row.tracking_number}\nAfter mailing, click Shipped in https://voltcards.us/ to update eBay.`,attachments:[{filename:'Volt-'+id+'.pdf',content:label.pdf_base64}]})});
  const d=await r.json();if(!r.ok) throw new Error('Label email failed: '+(d.message || r.status));
  checked(await svc.from('shipping_labels').update({emailed_at:new Date().toISOString(),email_id:d.id}).eq('order_id',id));return {sent:true};
}
Deno.serve(async req=>{
  if(req.method==='OPTIONS') return new Response('ok',{headers:cors});
  if(req.method!=='POST') return json({error:'POST required'},405);
  try{
    // Only the existing Volt owner or the stored scheduler secret may access shipments.
    const poll=req.headers.get('x-poll-secret');let scheduler=false;
    if(poll){const cfg=checked(await svc.from('app_config').select('value').eq('key','poll_secret').single());scheduler=!!cfg?.value && poll===cfg.value;}
    if(!scheduler){const token=(req.headers.get('Authorization') || '').replace(/^Bearer /i,'');const {data,error}=await svc.auth.getUser(token);if(error || data.user?.id!==OWNER) return json({error:'Forbidden'},403);}
    const body=await req.json();const action=body.action || 'list';
    if(scheduler && !['daily','sync','diagnostics'].includes(action)) return json({error:'Scheduler action not allowed'},403);
    if(action==='diagnostics'){
      let seller='',seller_error='';try{const user=await trading('GetUser','<DetailLevel>ReturnAll</DetailLevel>');seller=pick(user,'UserID');}catch(e){seller_error=String(e);}
      return json({seller,seller_error,configured:{ebay:!!env('EBAY_AUTH_TOKEN_2'),tracking:!!env('EASYPOST_API_KEY'),email:!!env('RESEND_API_KEY'),sender:!!env('RESEND_FROM'),logistics_oauth:!!env('EBAY_LOGISTICS_REFRESH_TOKEN')},label_mode:'ebay_pdf_upload',package_configured:false});
    }
    if(action==='sync') return json({ok:true,orders:await sync(),tracking:await tracking()});
    if(action==='daily'){
      const run=checked(await svc.from('shipping_runs').insert({}).select('id').single());
      try{
        const orders=await sync(),tracked=await tracking();
        const pending=checked(await svc.from('shipping_labels').select('order_id').is('emailed_at',null));const emails=[];
        for(const l of pending){try{emails.push({order:l.order_id,...await emailLabel(l.order_id)});}catch(e){emails.push({order:l.order_id,error:String(e)});}}
        const ready=checked(await svc.from('shipping_orders').select('id').eq('user_id',OWNER).eq('canceled',false).not('paid_at','is',null).is('handed_off_at',null).is('ebay_shipped_at',null));
        const result={ok:true,orders,tracking:tracked,emails,ready:ready.length,label_mode:'ebay_pdf_upload',automatic_label_purchase:false};
        checked(await svc.from('shipping_runs').update({finished_at:new Date().toISOString(),result}).eq('id',run.id));return json(result);
      }catch(e){await svc.from('shipping_runs').update({finished_at:new Date().toISOString(),result:{error:String(e)}}).eq('id',run.id);throw e;}
    }
    if(action==='list'){
      const rows=checked(await svc.from('shipping_orders').select('*').eq('user_id',OWNER).order('created_at',{ascending:false}).limit(1000));
      const labels=checked(await svc.from('shipping_labels').select('order_id,emailed_at').limit(1000));
      const last=checked(await svc.from('shipping_runs').select('*').order('started_at',{ascending:false}).limit(1));
      return json({ok:true,rows:rows.map((r:any)=>({...r,label:labels.find((l:any)=>l.order_id===r.id) || null})),last_run:last[0] || null,label_mode:'ebay_pdf_upload',email_sender_configured:!!env('RESEND_FROM')});
    }
    const id=String(body.id || '');if(!id || id.length>100) return json({error:'Order required'},400);
    if(action==='shipped') return json(await markShipped(id));
    if(action==='label'){
      await order(id);const label=checked(await svc.from('shipping_labels').select('pdf_base64').eq('order_id',id).single());return json(label);
    }
    if(action==='upload_label'){
      const row=await order(id);if(!row.paid_at || row.canceled || row.handed_off_at) throw new Error('Order is not ready to ship');
      const pdf=String(body.pdf_base64 || ''),code=String(body.tracking_number || '').trim(),carrier=String(body.carrier || '').trim();
      if(pdf.length>2800000 || !/^[A-Za-z0-9+/\r\n]+=*$/.test(pdf) || !atob(pdf.slice(0,8)).startsWith('%PDF-')) throw new Error('Upload a PDF label under 2 MB');
      if(!/^[A-Za-z0-9 -]{6,60}$/.test(code) || !['USPS','UPS','FedEx','DHLExpress'].includes(carrier)) throw new Error('Valid carrier and tracking required');
      const existing=checked(await svc.from('shipping_labels').select('order_id').eq('order_id',id).maybeSingle());
      if(existing) throw new Error('A label is already saved for this order; duplicate label upload blocked');
      checked(await svc.from('shipping_orders').update({tracking_number:code,carrier,tracker_id:null,delivery_status:null}).eq('id',id));
      checked(await svc.from('shipping_labels').insert({order_id:id,pdf_base64:pdf}));
      return json({ok:true,email:await emailLabel(id)});
    }
    if(action==='email_label') return json(await emailLabel(id));
    return json({error:'Unknown action'},400);
  }catch(e){console.error(String(e));return json({error:String(e)},400);}
});
