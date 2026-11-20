const statusLine = document.querySelector('#status');
const grant = document.querySelector('#grant');
let selected;
async function render() {
  if (!selected) {statusLine.textContent='No folder selected.'; return;}
  const allowed = await selected.handle.queryPermission({mode:'readwrite'}) === 'granted';
  grant.hidden = allowed;
  document.querySelector('#choose').textContent='Change folder';
  statusLine.textContent = selected.handle.name + (allowed ? ' · Ready to save. You can close this tab.' : ' · Authorization required.');
}
document.querySelector('#choose').onclick = async () => {
  try {
    const handle = await showDirectoryPicker({id:'diwan-order-pdfs',mode:'readwrite'});
    const same = selected && await handle.isSameEntry(selected.handle);
    const entry = {handle,id:same ? selected.id : crypto.randomUUID()};
    await identityStore('readwrite', store=>store.put(entry,'order-pdf-folder'));
    selected = entry;
    await chrome.storage.local.set({orderPdfFolderName:handle.name});
    await render();
  } catch (err) {if(err.name !== 'AbortError') statusLine.textContent=err.message;}
};
grant.onclick = async () => {
  try {await selected.handle.requestPermission({mode:'readwrite'}); await render();}
  catch(err){statusLine.textContent=err.message;}
};
identityStore('readonly',store=>store.get('order-pdf-folder')).then(entry=>{selected=entry;return render();}).catch(err=>{statusLine.textContent=err.message;});
