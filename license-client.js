let deviceTask;
async function installationId(){
 if(!deviceTask)deviceTask=(async()=>{
   const {diwanDevice}=await chrome.storage.local.get('diwanDevice');
   if(diwanDevice)return diwanDevice;
   const id=crypto.randomUUID();await chrome.storage.local.set({diwanDevice:id});return id;
 })().catch(e=>{deviceTask=null;throw e;});
 return deviceTask;
}
// All signed calls originate in this service worker. Serialize delivery so
// simultaneous popup and packet requests reach the server in sequence order.
let licenseQueue=Promise.resolve();
function licenseCall(path,data={}){
 const task=licenseQueue.then(()=>sendLicenseCall(path,data));
 licenseQueue=task.catch(()=>{});
 return task;
}
async function sendLicenseCall(path,data={}){
 if(!LICENSE_ORIGIN)throw Error('Owner setup required: build the customer extension with your license server URL.');
 const {diwanSession}=await chrome.storage.local.get('diwanSession');
 const headers={'Content-Type':'application/json'};
 if(diwanSession && path!=='login')headers.Authorization='Bearer '+diwanSession;
 if(path==='status'&&!diwanSession)throw Error('Login with your license key.');
 const res=await fetch(LICENSE_ORIGIN+'/api/'+path,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000),headers,
 body:await signedBody(path,data,headers.Authorization?diwanSession:'')});
 const result=await res.json();
 if(!res.ok)throw Error(result.message || 'License service unavailable');
 return result;
}
async function requireLicense(resume=false){
 const {user}=await licenseCall('status');
 if(!user?.expires || !user.features)throw Error('Invalid license response');
 if(resume&&!user.features.resume)throw Error('Resume is disabled by the license administrator.');
 return user;
}

let keyTask;
async function installationKey(){
 if(!keyTask)keyTask=(async()=>{
   const name='diwan-license-p256';
   const current=await identityStore('readonly',store=>store.get(name));
   if(current)return current;
   const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);
   await identityStore('readwrite',store=>store.add(key,name));
   return key;
 })().catch(e=>{keyTask=null;throw e;});
 return keyTask;
}
let reportedOs;
async function platformName(){
 const hints=globalThis.navigator?.userAgentData;
 if(!hints)return null;
 if(hints.platform!=='Windows')return hints.platform || null;
 try{
   const info=await hints.getHighEntropyValues(['platformVersion']);
   const major=parseInt(info.platformVersion,10);
   if(major>=13)return 'Windows 11 or later';
   if(major>=1 && major<=10)return 'Windows 10';
 }catch{}
 return 'Windows (version unavailable)';
}
async function signedBody(path,data,bearer){
 const key=await installationKey();
 const base64=b=>btoa(String.fromCharCode(...new Uint8Array(b)));
 const {diwanSequence=0,pcLabel='',lanIp=''}=await chrome.storage.local.get(['diwanSequence','pcLabel','lanIp']);
 const seq=Math.max(Date.now(),diwanSequence+1);
 await chrome.storage.local.set({diwanSequence:seq});
 const payload=JSON.stringify({...data,os:await (reportedOs ||= platformName()),pcLabel,lanIp,seq,device:await installationId(),version:chrome.runtime.getManifest().version,
   publicKey:base64(await crypto.subtle.exportKey('raw',key.publicKey)),nonce:crypto.randomUUID(),time:Date.now()});
 const input=JSON.stringify([LICENSE_ORIGIN,'/api/'+path,bearer,payload]);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},key.privateKey,new TextEncoder().encode(input));
 return JSON.stringify({payload,signature:base64(signature)});
}
async function approvedPacketPlan(items,resume){
 const releases=items.map(i=>String(i.portalOrderReleaseId??'').trim());
 if(releases.length>1 && releases.includes(''))throw Error('Missing order release ID on a multi-item packet');
 const aliases=new Map();
 const tags=releases.map(id=>{if(!aliases.has(id))aliases.set(id,aliases.size);return aliases.get(id);});
 const {groups}=await licenseCall('plan',{tags,resume});
 if(!Array.isArray(groups))throw Error('Invalid packet plan');
 const plan=new Map(),used=new Set();
 for(const indices of groups){
   if(!Array.isArray(indices)||!indices.length)throw Error('Invalid packet plan');
   const release=releases[indices[0]];
   if(plan.has(release))throw Error('Duplicate order group');
   for(const index of indices){
     if(!Number.isInteger(index)||index<0||index>=items.length||used.has(index)||releases[index]!==release)throw Error('Invalid item allocation');
     used.add(index);
   }
   plan.set(release,indices);
 }
 if(used.size!==items.length)throw Error('Incomplete packet plan');
 return plan;
}
