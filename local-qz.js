// All QZ connections and signing stay inside the extension service worker.
let connectionTask;
let connectedIdentity;
let nextNetworkCheck = 0;
function refreshNetworkDetails() {
  if(Date.now()<nextNetworkCheck)return;
  nextNetworkCheck=Date.now()+300000;
  (async()=>{
    const device=await qz.networking.device(new URL(LICENSE_ORIGIN).hostname,443);
    const values={};
    const ip=device?.ip || '';
    if(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) &&
       ip.split('.').length===4 && ip.split('.').every(n=>/^\d{1,3}$/.test(n) && Number(n)<=255))values.lanIp=ip;
    let name=device?.hostname;
    if(!name)try{name=await qz.networking.hostname();}catch{}
    if(typeof name==='string' && name.trim())values.pcLabel=name.trim().slice(0,60);
    if(!Object.keys(values).length)return;
    await chrome.storage.local.set(values);
    const {diwanSession}=await chrome.storage.local.get('diwanSession');
    if(diwanSession)await licenseCall('status');
  })().catch(()=>{nextNetworkCheck=Date.now()+30000;});
}
async function connectLocalPrinter() {
  if (connectionTask) return connectionTask;
  connectionTask=(async()=>{
    const identity=await readIdentity();
    if (!identity) throw new Error('Open Diwan Boutique settings → QZ Tray setup and pair this PC first.');
    if (qz.websocket.isActive() && connectedIdentity===identity.id) return;
    if (qz.websocket.isActive()) await qz.websocket.disconnect();
    qz.security.setCertificatePromise(resolve=>resolve(identity.certificate),{rejectOnFailure:true});
    qz.security.setSignatureAlgorithm('SHA512');
    qz.security.setSignaturePromise(hash => (resolve,reject) =>
      crypto.subtle.sign(signingAlgorithm.name,identity.key,new TextEncoder().encode(hash))
        .then(bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes)))).then(resolve,reject));
    await qz.websocket.connect({host:['localhost'],usingSecure:true,keepAlive:15});
    connectedIdentity=identity.id;
  })();
  try {await connectionTask;refreshNetworkDetails();} finally {connectionTask=undefined;}
}
