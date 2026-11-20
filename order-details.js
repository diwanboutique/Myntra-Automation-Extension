function orderFields(item, packet, shipment, styleOption={}) {
  const text=(...values)=>values.find(v=>typeof v==='string' && v.trim() || typeof v==='number' && Number.isFinite(v)) ?? '';
  function amount(...values) {
    for (const raw of values) {
      const v=typeof raw==='object'?raw?.amount:raw;
      if (typeof v==='number' && Number.isFinite(v) && v>=0) return v;
      if (typeof v==='string' && /^(?:₹|INR|Rs\.?)?\s*\d[\d,]*(?:\.\d{1,2})?$/i.test(v.trim())) return Number(v.replace(/^[^\d]+/,'').replace(/,/g,''));
    }
    return '';
  }
  const scope=[item,shipment,packet].filter(Boolean).flatMap(s=>[s,s.shipmentDetails,s.shippingDetails,s.orderDetails,s.deliveryDetails,s.logisticsDetails,s.shipment,s.order]).filter(Boolean);
  const prices=[item,item.priceDetails,item.pricing,item.price,item.pricingDetails,item.orderItemPriceDetails].filter(Boolean);
  const addresses=scope.flatMap(s=>[s.shippingAddress,s.deliveryAddress,s.shipToAddress,s.consigneeAddress,s.customerShippingAddress,s.delivery?.address,s.consignee?.address,s.customer?.shippingAddress]).filter(Boolean);
  const a=addresses[0] || {};
  const city=text(a.cityName,a.city),state=text(a.stateName,a.state);
  const parts=[text(a.addressLine1,a.address1,a.line1),text(a.addressLine2,a.address2,a.line2),text(a.addressLine3,a.address3,a.line3),a.locality,a.landmark,city,state,text(a.pincode,a.pinCode,a.postalCode,a.zipCode),a.country].filter(v=>typeof v==='string'&&v.trim() || typeof v==='number');
  const address=text(typeof a==='string'?a:'',a.fullAddress,a.address, (a.addressLine1 || a.address1 || a.line1 || a.addressLine2 || a.address2 || a.line2) ? parts.join(', ') : '');
  const shipping=scope.flatMap(s=>[s,s.shipmentDetails,s.shippingDetails,s.logisticsDetails]).filter(Boolean);
  const awb=text(...shipping.flatMap(s=>[s.trackingId,s.trackingNumber,s.awbNumber,s.awbNo,s.airwayBillNumber,s.awbCode,s.airWayBillNumber,s.trackingCode,s.awb]));
  return [String(awb),amount(...prices.flatMap(p=>[p.mrp,p.MRP,p.maximumRetailPrice,p.maxRetailPrice,p.itemMrp]),styleOption?.mrp),
    amount(...prices.flatMap(p=>[p.finalSellingPrice,p.sellingPrice,p.itemSellingPrice,p.unitSellingPrice])),
    amount(...scope.flatMap(s=>[s.orderPayableAmount,s.totalPayableAmount,s.customerPayableAmount])),
    text(a.name,a.fullName,a.recipientName,[a.firstName,a.lastName].filter(Boolean).join(' '),...scope.flatMap(s=>[s.customerName,s.consigneeName,s.recipientName])),
    address,city,state];
}

// Read only explicitly identified fields from this release's own documents.
function documentFields(lines, singleItem) {
  function labelled(pattern) {
    const match=lines.map(line=>line.match(new RegExp('^(?:'+pattern+')\\s*[:#-]\\s*(.+)$','i'))).find(Boolean);
    return match?.[1]?.trim() || '';
  }
  const awb=labelled('AWB(?:\\s*(?:No\\.?|Number|ID))?|Tracking (?:ID|No\\.?|Number)|Airway Bill (?:No\\.?|Number)');
  function price(pattern) {
    const m=labelled(pattern).match(/^(?:(?:INR|Rs\.?|₹)\s*)?([\d,]+(?:\.\d{1,2})?)$/i);
    return m?Number(m[1].replace(/,/g,'')):'';
  }
  const at=lines.findIndex(line=>/^(?:ship to|deliver to|shipping address|delivery address|consignee details)\s*:?$/i.test(line));
  const block=[];
  if(at>=0){
    for(const line of lines.slice(at+1,at+10)){
      if(/^(?:seller|sold by|return|bill(?:ing)?|invoice|order|sku|awb|tracking|courier|product|item|payment|phone|mobile|GST|HSN|MRP|amount)\b/i.test(line))break;
      block.push(line);
    }
  }
  const component=label=>block.map(line=>line.match(new RegExp('^'+label+'\\s*:\\s*(.+)$','i'))).find(Boolean)?.[1] || '';
  const name=labelled('Customer Name|Consignee Name|Recipient Name') || component('Name');
  const street=block.filter(line=>!/^name\s*:/i.test(line) && line!==name);
  const blockAddress=street.some(line=>/\b[1-9]\d{5}\b/.test(line))?street.join(', '):'';
  return [/^[\w-]+$/.test(awb)?awb:'',singleItem?price('MRP|Maximum Retail Price'):'',singleItem?price('Selling Price|Final Selling Price'):'',
    price('Total Amount Payable|Order Total|Customer Payable Amount|Grand Total'),name,
    labelled('Full Delivery Address|Full Shipping Address|Consignee Address|Delivery Address|Shipping Address') || blockAddress,
    labelled('Delivery City|Shipping City|Consignee City') || component('City'),labelled('Delivery State|Shipping State|Consignee State') || component('State')];
}

const pdfReaderLoads = new Map();
async function ensurePdfReader(tabId) {
  const target={tabId};
  const [loaded]=await chrome.scripting.executeScript({target,func:()=>typeof readOrderPages==='function' && !!globalThis.pdfjsWorker});
  if (!loaded?.result) await chrome.scripting.executeScript({target,files:['pdfjs/pdf.min.js','pdfjs/pdf.worker.min.js','pdf-fields.js']});
}
async function extractOrderPdfText(tabId,base64) {
  if(!pdfReaderLoads.has(tabId)){
    pdfReaderLoads.set(tabId,ensurePdfReader(tabId).finally(()=>pdfReaderLoads.delete(tabId)));
  }
  await pdfReaderLoads.get(tabId);
  const target={tabId};
  const [result]=await chrome.scripting.executeScript({target,args:[base64],func:async data=>{
    try {return {pages:await readOrderPages(Uint8Array.from(atob(data),c=>c.charCodeAt(0)))};}
    catch(e){return {error:e.message};}
  }});
  if (!result?.result?.pages) throw Error(result?.result?.error || 'PDF reader unavailable');
  return result.result.pages;
}
