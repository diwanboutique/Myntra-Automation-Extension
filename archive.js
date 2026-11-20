async function getArchiveFolder() {
  const entry = await identityStore('readonly', store => store.get('order-pdf-folder'));
  if (!entry || await entry.handle.queryPermission({mode:'readwrite'}) !== 'granted')
    throw Error('Open PDF Save Settings → Choose / authorize folder, then resume.');
  return entry;
}
function archiveDate(now) {
  return [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
}
async function saveOrderArchive(folder, orderId, docs, packetId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(orderId)) throw Error('Invalid order ID for PDF filename');
  const key = 'orderArchive:'+folder.id+':'+orderId;
  const previous = (await chrome.storage.local.get(key))[key];
  const day = previous?.day || archiveDate(new Date());
  const directory = await folder.handle.getDirectoryHandle(day,{create:true});
  // Existing receipts keep their original path when a batch is resumed.
  if(!previous && !/^\d+$/.test(packetId || ''))throw Error('Packet ID could not be read from the invoice.');
  const name=previous ? previous.name || orderId+'.pdf' : packetId+'.pdf';
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  let existing;
  try { existing = await directory.getFileHandle(name); }
  catch (err) { if (err.name !== 'NotFoundError') throw err; }
  let actual;
  if (existing) {
    actual = await hash(await (await existing.getFile()).arrayBuffer());
    if (actual === previous?.digest) return day+'/'+name;
  }
  const pdf = await PDFLib.PDFDocument.create({updateMetadata:false});
  for (const kind of ['Label','Invoice']) {
    const source = await PDFLib.PDFDocument.load(docs.find(d=>d.kind===kind).data);
    if (!source.getPageCount()) throw Error(kind+' PDF has no pages');
    for (const page of await pdf.copyPages(source,source.getPageIndices())) pdf.addPage(page);
  }
  const bytes = await pdf.save();
  const digest = await hash(bytes);
  if (existing && actual !== digest && !(previous?.writing && (await existing.getFile()).size === 0))
    throw Error('A different file already exists at '+day+'/'+name+'. Move it and resume.');
  await chrome.storage.local.set({[key]:{day,name,digest,writing:true}});
  if (actual !== digest) {
    const file = existing || await directory.getFileHandle(name,{create:true});
    const stream = await file.createWritable();
    try { await stream.write(bytes); await stream.close(); }
    catch (err) { try { await stream.abort(); } catch {} throw err; }
  }
  await chrome.storage.local.set({[key]:{day,name,digest}});
  return day+'/'+name;
}
