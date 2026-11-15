export const escapeXml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
export const decodeXml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&#x([\da-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
export const pick = (xml: string, tag: string) => decodeXml((xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || '').trim();
export const blocks = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`,'g')) || [];
export function checkAck(xml: string) {
  if (!['Success','Warning'].includes(pick(xml,'Ack'))) throw new Error(pick(xml,'LongMessage') || 'eBay request failed');
  // Warning responses can contain a failed operation; never treat that as success.
  if (blocks(xml,'Errors').some(e=>pick(e,'SeverityCode')==='Error')) throw new Error(pick(xml,'LongMessage') || 'eBay operation failed');
}
export function parseSellerOrders(xml: string, userId: string) {
  checkAck(xml);
  return blocks(xml,'Order').map(ob=>{
    const address = pick(ob,'ShippingAddress');
    const shipping = pick(ob,'ShippingServiceSelected');
    const transactions = blocks(ob,'Transaction');
    const tracking = blocks(ob,'ShipmentTrackingDetails')[0] || '';
    const total = (ob.match(/<Total currencyID="([^"]+)">([^<]+)<\/Total>/) || []);
    const row = {
      id: pick(ob,'OrderID'), user_id:userId, account:'voltcardsus',
      created_at:pick(ob,'CreatedTime'), paid_at:pick(ob,'PaidTime') || null,
      canceled:['Cancelled','Canceled'].includes(pick(ob,'OrderStatus')) || ['CancelComplete','CancelClosedWithRefund'].includes(pick(ob,'CancelStatus')),
      buyer:pick(ob,'BuyerUserID'),
      destination:{name:pick(address,'Name'),street1:pick(address,'Street1'),street2:pick(address,'Street2'),city:pick(address,'CityName'),state:pick(address,'StateOrProvince'),postal:pick(address,'PostalCode'),country:pick(address,'Country')},
      service:pick(shipping,'ShippingService'), total:total[2] ? Number(total[2]) : null, currency:total[1] || 'USD',
      items:transactions.map(t=>({line_id:pick(t,'OrderLineItemID'),item_id:pick(pick(t,'Item'),'ItemID'),title:pick(pick(t,'Item'),'Title'),quantity:Number(pick(t,'QuantityPurchased')) || 1})),
      updated_at:new Date().toISOString(),
      // Missing eBay tracking must never erase an uploaded label's tracking.
      ...(pick(tracking,'ShipmentTrackingNumber') ? {tracking_number:pick(tracking,'ShipmentTrackingNumber'),carrier:pick(tracking,'ShippingCarrierUsed')} : {}),
      ...(pick(ob,'ShippedTime') ? {ebay_shipped_at:pick(ob,'ShippedTime')} : {})
    };
    if (!row.id || !row.created_at || !row.items.length) throw new Error('Incomplete seller order returned by eBay');
    return row;
  });
}
export function canShip(row: any) {
  return !!row.paid_at && !row.canceled && !!row.tracking_number && !!row.carrier;
}
