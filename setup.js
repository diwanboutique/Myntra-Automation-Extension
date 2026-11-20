const message=document.querySelector('#status'), form=document.querySelector('form'), test=document.querySelector('#test');
readIdentity().then(pair=>message.textContent=pair?'A certificate is saved on this PC.':'Select the certificate and matching private key.').catch(e=>message.textContent=e.message);
form.onsubmit=async event=>{
  event.preventDefault();
  const save=form.querySelector('button');
  save.disabled=true;
  try {
    const read=id=>document.getElementById(id).files[0].text();
    const pair=await makeIdentity(await read('cert'),await read('pem'));
    await identityStore('readwrite',s=>s.put(pair,'printer'));
    form.reset();
    message.textContent='Pair saved. Test the signed connection below.';
  } catch(e){message.textContent='Pairing failed. '+e.message;} finally {save.disabled=false;}
};
test.onclick=async()=>{
  test.disabled=true;
  try {
    const result=await chrome.runtime.sendMessage({action:'GET_PRINTERS'});
    if(!result?.success) throw new Error(result?.error || 'No reply');
    message.textContent='Signed connection succeeded. Printers found: '+result.printers.length;
  } catch(e){message.textContent=e.message;} finally{test.disabled=false;}
};
