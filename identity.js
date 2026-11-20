async function identityStore(mode, operation) {
  return new Promise((resolve,reject) => {
    const open = indexedDB.open('diwan-qz',1);
    open.onupgradeneeded = () => open.result.createObjectStore('identities');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('identities',mode);
      const req = operation(tx.objectStore('identities'));
      tx.oncomplete = () => {db.close(); resolve(req.result);};
      tx.onabort = () => {db.close(); reject(tx.error || new Error('Local storage unavailable'));};
    };
  });
}
function readIdentity() {
  return identityStore('readonly', store => store.get('printer'));
}
function decodePem(text,label) {
  const match = text.match(new RegExp('-----BEGIN '+label+'-----([A-Za-z0-9+/=\\s]+)-----END '+label+'-----'));
  if (!match) throw new Error('Expected '+label+' PEM file');
  return Uint8Array.from(atob(match[1].replace(/\s/g,'')), c => c.charCodeAt(0));
}
// Read the SubjectPublicKeyInfo field of an X.509 TBSCertificate.
function certificatePublicKey(bytes) {
  function field(start, limit) {
    let pos=start+2, size=bytes[start+1];
    if (pos>limit) throw new Error('Truncated certificate');
    if (size>=128) {
      const count=size-128;
      if (!count || count>4 || pos+count>limit) throw new Error('Invalid certificate length');
      size=0;
      for(let i=0;i<count;i++) size=size*256+bytes[pos++];
    }
    if (pos+size>limit) throw new Error('Invalid certificate field');
    return {tag:bytes[start],start,body:pos,end:pos+size};
  }
  const outer=field(0,bytes.length), tbs=field(outer.body,outer.end);
  let entry=field(tbs.body,tbs.end);
  if(entry.tag===160) entry=field(entry.end,tbs.end);
  for(let i=0;i<5;i++) entry=field(entry.end,tbs.end);
  if(entry.tag!==48) throw new Error('Invalid certificate public key');
  return bytes.slice(entry.start,entry.end);
}
const signingAlgorithm = {name:'RSASSA-PKCS1-v1_5',hash:'SHA-512'};
async function makeIdentity(certificate, pem) {
  const cert = decodePem(certificate,'CERTIFICATE');
  const privateBytes=decodePem(pem,'PRIVATE KEY');
  let key;
  try {key=await crypto.subtle.importKey('pkcs8',privateBytes,signingAlgorithm,false,['sign']);}
  finally {privateBytes.fill(0);}
  const pub=await crypto.subtle.importKey('spki',certificatePublicKey(cert),signingAlgorithm,false,['verify']);
  const test=crypto.getRandomValues(new Uint8Array(32));
  const signature=await crypto.subtle.sign(signingAlgorithm.name,key,test);
  if(!await crypto.subtle.verify(signingAlgorithm.name,pub,signature,test)) throw new Error('Certificate and private key do not match');
  return {id:crypto.randomUUID(),certificate,key};
}
