// One dispatch group per release and destination. Both documents must be
// available before sending either one; the next release waits for both.
let nextDispatchTime = 0;

function printOrderPair(options) {
  return navigator.locks.request('diwan-shipment-dispatch',()=>dispatchOrderPair(options));
}

async function shipmentIdentity(docs,tabId,sellerId,speedMode) {
  async function fingerprint(doc) {
    try {doc.pages=await extractOrderPdfText(tabId,doc.data);} catch {}
    const lines=(doc.pages || []).flatMap(page=>page.map(row=>row.map(t=>t.text).join(' ')));
    let id;
    if(doc.kind==='Invoice'){
      const text=lines.join(' ');
      const invoice=text.match(/\bInvoice Number:\s*([A-Z0-9-]+)/i)?.[1];
      const packet=text.match(/\bPacket\s*ID:\s*([0-9]+)/i)?.[1];
      doc.packetId=packet;
      if(invoice && packet)id=[invoice,packet];
    }else{
      id=lines.map(l=>l.match(/^AWB:\s*([A-Z0-9-]+)$/i)?.[1]).find(Boolean);
    }
    if(!id){
      const bytes=Uint8Array.from(atob(doc.data),c=>c.charCodeAt(0));
      const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
      id=Array.from(hash,b=>b.toString(16).padStart(2,'0')).join('');
    }
    return [doc.kind,id];
  }
  const fingerprints=[];
  if(speedMode==='faster' || speedMode==='express'){
    fingerprints.push(...await Promise.all(docs.map(fingerprint)));
  } else {
    for(const doc of docs) fingerprints.push(await fingerprint(doc));
  }
  return 'diwanShipment:'+JSON.stringify([sellerId,...fingerprints]);
}

async function dispatchOrderPair({speedMode,sellerId,docs,tabId,xsrfToken,archiveFolder,sellerOrderId,sellerPacketId,currentRows,recordStatus,singleItem}) {
  const receipts=await chrome.storage.local.get(docs.map(d=>d.key));
  const pending=[];
  for(const doc of docs){
    const receipt=receipts[doc.key];
    if(receipt?.status==='submitted') await recordStatus('Pending',doc.kind,receipt.output);
    else if(receipt){
      await recordStatus('Unconfirmed',doc.kind,'Unconfirmed');
      throw Error(doc.kind+' has an unconfirmed attempt. Check the print queue before reprinting.');
    } else pending.push(doc);
  }
  if(!pending.length && !archiveFolder)return true;
  const needed = docs;
  while(true){
    const prepared=await Promise.allSettled(needed.map(async doc=>{
      const [reply]=await chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:fetchOrderPdf,args:[doc.url,xsrfToken]});
      if(!reply?.result?.data)throw Error(reply?.result?.error || 'Empty PDF response');
      doc.data=reply.result.data;
    }));
    const failed=prepared.findIndex(r=>r.status==='rejected');
    let cause, label;
    if(failed>=0){cause=prepared[failed].reason;label=needed[failed].kind;}
    else if(pending.some(d=>!d.savePdf)){
      try{await connectLocalPrinter();}catch(e){cause=e;label=pending.find(d=>!d.savePdf).kind;}
    }
    if(!cause)break;
    await recordStatus('Failed',label,'Failed: '+cause.message);
    const [choice]=await chrome.scripting.executeScript({target:{tabId},func:(kind,id,msg)=>window.confirm(kind+' for '+id+': '+msg+'\nRetry this pair?'),args:[label,sellerOrderId,cause.message]});
    if(!choice?.result)return false;
  }

  const identity=await shipmentIdentity(docs,tabId,sellerId,speedMode);
  const stored=(await chrome.storage.local.get(identity))[identity];
  const owner=stored || {id:sellerOrderId,keys:Object.fromEntries(docs.map(d=>[d.kind,d.key]))};
  if(!stored)await chrome.storage.local.set({[identity]:owner});
  if(stored){
    const shared=await chrome.storage.local.get(Object.values(owner.keys));
    for(let i=pending.length-1;i>=0;i--){
      const doc=pending[i],key=owner.keys[doc.kind],receipt=shared[key];
      doc.key=key;
      if(!receipt)continue;
      if(receipt.status!=='submitted'){
        await recordStatus('Unconfirmed',doc.kind,'Unconfirmed');
        throw Error('Check the print queue for the shared shipment before reprinting.');
      }
      await recordStatus('Pending',doc.kind,receipt.output);
      pending.splice(i,1);
    }
    if(owner.id!==sellerOrderId)log('Same shipment as '+owner.id+' · using its label and invoice for '+sellerOrderId,'info');
  }
  if (archiveFolder) {
    try {
      const path = await saveOrderArchive(archiveFolder,owner.id,docs,docs.find(d=>d.kind==='Invoice')?.packetId);
      if(owner.id!==sellerOrderId){
        const prefix='orderArchive:'+archiveFolder.id+':';
        const original=(await chrome.storage.local.get(prefix+owner.id))[prefix+owner.id];
        await chrome.storage.local.set({[prefix+sellerOrderId]:{...original,fileId:owner.id}});
      }
      log('Saved PDF: '+archiveFolder.handle.name+'/'+path,'success');
    } catch (err) {
      await recordStatus('Failed');
      throw Error('Order '+sellerOrderId+' PDF could not be saved: '+err.message);
    }
  }
  if(pending.length){
  const groups=new Map();
  for(const doc of pending){
    const destination=doc.savePdf?'combined-pdf':'printer:'+doc.printer;
    if(!groups.has(destination))groups.set(destination,[]);
    groups.get(destination).push(doc);
  }
  for(const doc of pending)for(const row of currentRows)row[doc.kind==='Invoice'?11:12]='Submitting';
  await recordStatus('Unconfirmed');
  const gap=nextDispatchTime-Date.now();
  if(gap>0)await delay(gap);
  const before={};
  for(const d of pending)if(!d.savePdf)before[d.key]={status:'pending'};
  await chrome.storage.local.set(before);
  const jobs=[...groups.values()];
  const results=await Promise.allSettled(jobs.map(async group=>{
    const first=group[0];
    if(first.savePdf) return 'Saved PDF';
    await qz.print(qz.configs.create(first.printer,{copies:1}),group.map(d=>({type:'pixel',format:'pdf',flavor:'base64',data:d.data})));
    return 'Queued: '+first.printer;
  }));
  nextDispatchTime=Date.now()+2000;
  const confirmed={};
  let error;
  for(const [i,r] of results.entries()){
    for(const doc of jobs[i]){
      if(r.status==='fulfilled'){
        confirmed[doc.key]={status:'submitted',output:r.value};
        for(const row of currentRows)row[doc.kind==='Invoice'?11:12]=r.value;
      }else{
        error=r.reason || Error('No acknowledgement');
        for(const row of currentRows)row[doc.kind==='Invoice'?11:12]='Unconfirmed: '+error.message;
      }
    }
  }
  if(Object.keys(confirmed).length)await chrome.storage.local.set(confirmed);
  if(error){await recordStatus('Unconfirmed');throw error;}
  }
  // Text extraction is for Excel and never separates two print submissions.
  for(const doc of needed){
    if(!currentRows.some(row=>row.slice(14,22).includes('') || row[23]==null))break;
    try{
      const pages=doc.pages || await extractOrderPdfText(tabId,doc.data);
      if(!pages.some(page=>page.length))throw Error('No selectable text');
      for(const row of currentRows) {
        const fields=capturePdfFields(pages,singleItem,row.slice(3,7).map(String));
        fields.forEach((v,i)=>{const col=i===8?23:14+i;if((row[col]==null || row[col]==='') && v!=='')row[col]=v;});
      }
    }catch(err){log('Excel: '+doc.kind+' for '+sellerOrderId+' could not be read: '+err.message,'warn');}
  }
  if(currentRows.some(row=>row.slice(14,22).includes('')))log('Excel: some fields were not identified for '+sellerOrderId+'. Check the original label and invoice.','warn');
  return true;
}

async function fetchOrderPdf(url,xsrfToken) {

  // Fetch a URL and return its content as a base64 string (with retry on 500/504)
  async function fetchBase64(url) {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: {
          'accept': '*/*',
          'x-myntra-xsrf-token': xsrfToken,
          'x-myntra-app-name': 'mdirect',
          'x-myntra-client-id': 'mdirect',
          'x-requested-with': 'XMLHttpRequest',
          'origin': 'https://mdirect.myntrainfo.com',
          'referer': 'https://mdirect.myntrainfo.com/',
        },
      });
      if (resp.ok) {
        const blob = await resp.blob();
        if (!(await blob.slice(0,1024).text()).includes('%PDF-')) throw new Error('Myntra returned an invalid PDF');
        return new Promise((res, rej) => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result.split(',')[1]);
          reader.onerror = rej;
          reader.readAsDataURL(blob);
        });
      }
      if ([500, 502, 503, 504].includes(resp.status) && attempt < maxRetries) {
        const retryDelay = Math.min(3000 * attempt, 12000);
        await new Promise(r => setTimeout(r, retryDelay));
        continue;
      }
      throw new Error(`HTTP ${resp.status} from ${url}`);
    }
  }

  try {return {data:await fetchBase64(url)};}
  catch (err) {return {error:err.message,dispatchStarted:false};}
}
