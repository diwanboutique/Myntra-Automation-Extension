const select=document.querySelector('select'), link=document.querySelector('a'), statusLine=document.querySelector('[role=status]');
const batches=new Map();
let generation=0, objectUrl;
async function prepareWorkbook() {
  const current=++generation;
  document.querySelector('#recover').hidden=false;
  link.hidden=true;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  const {barcode,rows,partial}=batches.get(select.value);
  statusLine.textContent='Preparing workbook…';
  try {
    const blob=await createOrderWorkbook({rows});
    if (generation!==current) return;
    objectUrl=URL.createObjectURL(blob);
    link.href=objectUrl;
    link.download='DIWAN_'+String(barcode).replace(/[^\w-]/g,'_')+(partial?'_saved_rows':'')+'.xlsx';
    link.hidden=false;
    statusLine.textContent=rows.length+' item row(s) ready. Click Save Excel below.';
  } catch(e){if (generation===current) statusLine.textContent='Workbook could not be prepared: '+e.message;}
}
async function loadBatches() {
  const all=await chrome.storage.local.get(null);
  if(all.diwanLastBatch?.rows?.length)batches.set('complete',all.diwanLastBatch);
  for(const [key,v] of Object.entries(all)){
    if(key.startsWith('diwanDraft:') && v?.rows?.length)batches.set(key,{barcode:v.rows[0][0],rows:v.rows,partial:true});
  }
  if(!batches.size){statusLine.textContent='No order rows saved in this extension profile. Open the original Chrome profile and extension folder used for printing.';return;}
  for(const [id,b] of batches)select.add(new Option(b.barcode+(b.partial?' · Saved order rows':' · Completed batch'),id));
  document.querySelector('label').hidden=false;
  const requested=new URLSearchParams(location.search).get('draft');
  if(requested && batches.has(requested))select.value=requested;
  select.addEventListener('change',prepareWorkbook);
  await prepareWorkbook();
}
loadBatches().catch(e=>statusLine.textContent='Could not read saved records: '+e.message);

document.querySelector('#recover').onclick=async function(){
  this.disabled=true;select.disabled=true;
  let filled=0, missing=0;
  try {
    const folder=await identityStore('readonly',s=>s.get('order-pdf-folder'));
    if(!folder || await folder.handle.queryPermission({mode:'read'})!=='granted')
      throw Error('Authorize the saved folder in PDF Save Settings first.');
    const batch=batches.get(select.value),orders=new Map();
    for(const row of batch.rows){
      const id=String(row[1]);
      if(!orders.has(id))orders.set(id,[]);
      orders.get(id).push(row);
    }
    for(const [id,rows] of orders){
      if(!rows.some(row=>row[23]==null || row.slice(14,22).some(v=>!v && v!==0 || v==='Unavailable')))continue;
      const key='orderArchive:'+folder.id+':'+id;
      const receipt=(await chrome.storage.local.get(key))[key];
      if(!receipt){missing++;continue;}
      try{
        const dir=await folder.handle.getDirectoryHandle(receipt.day);
        const file=await (await dir.getFileHandle(receipt.name || (receipt.fileId || id)+'.pdf')).getFile();
        const bytes=await file.arrayBuffer();
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
        if(digest!==receipt.digest){missing++;continue;}
        const pages=await readOrderPages(new Uint8Array(bytes));
        for(const row of rows){
          capturePdfFields(pages,rows.length===1,row.slice(3,7).map(String)).forEach((v,i)=>{
            const col=i===8?23:14+i;
            if((row[col]==null || row[col]==='' || row[col]==='Unavailable') && v!==''){row[col]=v;filled++;}
          });
        }
      }catch{missing++;}
    }
    await prepareWorkbook();
    statusLine.textContent=filled+' missing field(s) recovered for this download. '+missing+' order PDF(s) unavailable or changed. Click Save Excel.';
  }catch(e){statusLine.textContent=e.message;}
  finally{this.disabled=false;select.disabled=false;}
};
