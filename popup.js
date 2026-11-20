// ─────────────────────────────────────────────────────────────
//  popup.js  –  Myntra Order Automation – Auth + Config popup
//  Email+Password auth via MOA License Server
// ─────────────────────────────────────────────────────────────
'use strict';



const STORAGE_KEYS = {
  AUTH: 'moaAuth',
  CONFIG: 'moaConfig',
};

const DEFAULTS = {
  invoicePrinter: 'TSC DA310',
  labelPrinter: 'TSC DA310',
  defaultCoverId: 'myntra123',
  askCoverIdPerOrder: false,
  stepDelay: 1500,
  pauseOnSkuChange: true,
  archiveOrders: false,
};

// ── DOM refs ──────────────────────────────────────────────────
const authScreen = document.getElementById('auth-screen');
const settingsScreen = document.getElementById('settings-screen');
const subBar = document.getElementById('sub-bar');
const subPlanBadge = document.getElementById('sub-plan-badge');
const subExpiry = document.getElementById('sub-expiry');
const btnLogout = document.getElementById('btn-logout');

const formLogin=document.getElementById('form-login');
const loginKey=document.getElementById('login-password');
const loginError=document.getElementById('login-error');
const btnLogin=document.getElementById('btn-login');
chrome.storage.local.get(['pcLabel', 'lanIp']).then(({pcLabel, lanIp}) => {
  document.getElementById('pc-label').value = pcLabel || '';
  document.getElementById('lan-ip').value = lanIp || '';
});

// Settings
const cfgInvoicePrinter = document.getElementById('cfg-invoice-printer');
const cfgLabelPrinter = document.getElementById('cfg-label-printer');
const cfgCoverId = document.getElementById('cfg-cover-id');
const cfgScanPerOrder = document.getElementById('cfg-scan-per-order');
const cfgDelay = document.getElementById('cfg-delay');
const cfgPauseOnSku = document.getElementById('cfg-pause-sku');
const cfgArchive = document.getElementById('cfg-archive');
chrome.storage.local.get('orderPdfFolderName').then(v=>{
  document.getElementById('pdf-folder-name').textContent = v.orderPdfFolderName || 'No folder selected';
});
const saveIndicator = document.getElementById('save-indicator');
const btnRefresh = document.getElementById('btn-refresh-printers');
const printerStatus = document.getElementById('printer-status');
const refreshIcon = document.getElementById('refresh-icon');

// ══════════════════════════════════════════════════════════════
let expiryTimer;
function startExpiryCountdown(expires){
  clearInterval(expiryTimer);
  function render(){
    const seconds=Math.ceil((expires-Date.now())/1000);
    if(!Number.isFinite(seconds) || seconds<=0){
      showAuth('Licence expired. Please renew your key.');
      return false;
    }
    const days=Math.floor(seconds/86400);
    const clock=[Math.floor(seconds/3600)%24, Math.floor(seconds/60)%60, seconds%60]
      .map(value=>String(value).padStart(2,'0')).join(':');
    subExpiry.textContent='EXPIRE - '+days+' DAY '+clock;
    return true;
  }
  if(!render())return false;
  expiryTimer=setInterval(render,1000);
  return true;
}
function showAuth(message=''){
  clearInterval(expiryTimer);
  authScreen.classList.remove('hidden');
  settingsScreen.classList.remove('visible');
  subBar.classList.add('hidden');
  loginError.textContent=message;loginError.classList.toggle('show',!!message);
}
async function showSettings(user){
  authScreen.classList.add('hidden');
  settingsScreen.classList.add('visible');
  subBar.classList.remove('hidden');
  subPlanBadge.textContent=Number.isInteger(user.planDays) ? 'ACTIVE - '+user.planDays+' DAY' : 'ACTIVE';
  if(!startExpiryCountdown(user.expires))return;
  await loadConfig();fetchPrinters();
}
formLogin.onsubmit=async event=>{
  event.preventDefault();btnLogin.disabled=true;
  try{
    const result=await chrome.runtime.sendMessage({action:'LICENSE_LOGIN',key:loginKey.value.trim()});
    if(!result?.user)throw Error(result?.message || 'Login failed');
    loginKey.value='';await showSettings(result.user);
  }catch(e){showAuth(e.message);}finally{btnLogin.disabled=false;}
};
async function checkAuth(){
  try{
    const r=await chrome.runtime.sendMessage({action:'GET_LICENSE_STATUS'});
    if(r?.licensed)await showSettings(r.user);else showAuth(r?.message);
  }catch(e){showAuth(e.message);}
}
btnLogout.onclick=async()=>{
  try{await chrome.runtime.sendMessage({action:'LICENSE_LOGOUT'});}finally{showAuth();}
};

//  CONFIG MANAGEMENT
// ══════════════════════════════════════════════════════════════

let currentConfig = { ...DEFAULTS };

async function loadConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  currentConfig = { ...DEFAULTS, ...(result[STORAGE_KEYS.CONFIG] || {}) };

  [cfgInvoicePrinter, cfgLabelPrinter].forEach(sel => {
    const val = sel === cfgInvoicePrinter ? currentConfig.invoicePrinter : currentConfig.labelPrinter;
    if (val && !Array.from(sel.options).some(o => o.value === val)) {
      sel.add(new Option(val, val));
    }
    sel.value = val;
  });

  cfgCoverId.value = currentConfig.defaultCoverId;
  cfgScanPerOrder.checked = currentConfig.askCoverIdPerOrder;
  cfgDelay.value = currentConfig.stepDelay;
  cfgPauseOnSku.checked = currentConfig.pauseOnSkuChange;
  cfgArchive.checked = !!currentConfig.archiveOrders;
}

async function fetchPrinters() {
  btnRefresh.disabled = true;
  refreshIcon.classList.add('spin');
  printerStatus.textContent = 'Fetching printers...';
  printerStatus.className = 'printer-status';

  chrome.runtime.sendMessage({ action: 'GET_PRINTERS' }, (response) => {
    btnRefresh.disabled = false;
    refreshIcon.classList.remove('spin');

    if (chrome.runtime.lastError || !response) {
      printerStatus.textContent = 'Extension error. Please reload.';
      printerStatus.className = 'printer-status err';
      return;
    }
    if (!response.success) {
      printerStatus.textContent = response.error || 'Failed to fetch printers.';
      printerStatus.className = 'printer-status err';
      return;
    }
    const printers = response.printers || [];
    if (printers.length === 0) {
      printerStatus.textContent = 'No printers found.';
      printerStatus.className = 'printer-status err';
      return;
    }

    [cfgInvoicePrinter, cfgLabelPrinter].forEach(sel => {
      const currentVal = sel.value;
      sel.innerHTML = '';
      const stdPdfOptions = ['Save as PDF', 'Microsoft Print to PDF'];
      const allPrinters = Array.from(new Set([...stdPdfOptions, ...printers]));

      allPrinters.forEach(p => sel.add(new Option(p, p)));

      if (allPrinters.includes(currentVal)) {
        sel.value = currentVal;
      } else if (sel === cfgInvoicePrinter && allPrinters.includes(currentConfig.invoicePrinter)) {
        sel.value = currentConfig.invoicePrinter;
      } else if (sel === cfgLabelPrinter && allPrinters.includes(currentConfig.labelPrinter)) {
        sel.value = currentConfig.labelPrinter;
      } else {
        sel.value = 'Save as PDF';
      }
    });

    printerStatus.textContent = `Found ${printers.length} printer(s).`;
    printerStatus.className = 'printer-status ok';
    saveConfig();
  });
}

let saveTimeout = null;
function saveConfig() {
  const cfg = {
    invoicePrinter: cfgInvoicePrinter.value.trim() || DEFAULTS.invoicePrinter,
    labelPrinter: cfgLabelPrinter.value.trim() || DEFAULTS.labelPrinter,
    defaultCoverId: cfgCoverId.value.trim() || DEFAULTS.defaultCoverId,
    askCoverIdPerOrder: cfgScanPerOrder.checked,
    stepDelay: parseInt(cfgDelay.value, 10) || DEFAULTS.stepDelay,
    pauseOnSkuChange: cfgPauseOnSku.checked,
    archiveOrders: cfgArchive.checked,
  };
  chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: cfg });
  currentConfig = cfg;
  saveIndicator.textContent = '✓ Settings saved';
  saveIndicator.classList.add('saved');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    saveIndicator.textContent = 'Settings auto-saved';
    saveIndicator.classList.remove('saved');
  }, 2000);
}

// ── Attach config listeners ──────────────────────────────────
[cfgInvoicePrinter, cfgLabelPrinter, cfgCoverId, cfgDelay].forEach(el => {
  el.addEventListener('change', saveConfig);
  if (el.tagName === 'INPUT') el.addEventListener('input', saveConfig);
});
cfgScanPerOrder.addEventListener('change', saveConfig);
cfgPauseOnSku.addEventListener('change', saveConfig);
cfgArchive.addEventListener('change', saveConfig);
btnRefresh.addEventListener('click', fetchPrinters);



// ── Init ─────────────────────────────────────────────────────
checkAuth();

connectBatchExport(document.getElementById('diwan-export'));

document.getElementById('open-order-panel').addEventListener('click', async () => {
  const status=document.getElementById('panel-status');
  try {
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if (!tab?.url?.startsWith('https://mdirect.myntrainfo.com/')) throw new Error('Open your Myntra Direct Orders tab, then click this button again.');
    const reply=await chrome.tabs.sendMessage(tab.id,{action:'OPEN_ORDER_PANEL'});
    if (!reply?.opened) throw new Error('Refresh the Myntra tab, then try again.');
    window.close();
  } catch (err) {
    status.textContent=err.message.includes('Receiving end')?'Refresh your Myntra tab once, then open this panel again.':err.message;
  }
});

// Read-only recovery for local drafts left by interrupted runs in earlier versions.
async function showSavedPicklists() {
  const select=document.getElementById('saved-picklist');
  const records=await chrome.storage.local.get(null);
  for (const [key,draft] of Object.entries(records)) {
    if (!key.startsWith('diwanDraft:') || !draft?.rows?.length) continue;
    const [seller,barcode]=JSON.parse(key.slice('diwanDraft:'.length));
    select.add(new Option(barcode+' · Seller '+seller+' · '+draft.rows.length+' item(s)',key));
  }
  document.getElementById('saved-reports').hidden=!select.options.length;
}
showSavedPicklists();
document.getElementById('recover-rows').addEventListener('click',async()=>{
  const key=document.getElementById('saved-picklist').value;
  const status=document.getElementById('recover-result');
  try {
    const result=await chrome.runtime.sendMessage({action:'EXPORT_DIWAN',draftKey:key});
    if (!result?.ok) throw new Error(result?.error || 'Could not open Excel downloads.');

  } catch (error) {status.textContent=error.message;}
});


(async()=>{
 if(!LICENSE_ORIGIN)return;
 try{
 const {version}=await (await fetch(LICENSE_ORIGIN+'/api/release',{cache:'no-store',signal:AbortSignal.timeout(6000)})).json();
 if(typeof version!=='string'||!/^\d+(\.\d+){0,3}$/.test(version))return;
 const installed=chrome.runtime.getManifest().version.split('.').map(Number),remote=version.split('.').map(Number);
 for(let i=0;i<4;i++){
   const delta=(remote[i]||0)-(installed[i]||0);
   if(delta<0)return;
   if(delta>0){
     const a=document.getElementById('release-link');a.href=LICENSE_ORIGIN+'/api/download/'+version;a.target='_blank';a.rel='noopener';a.textContent='Download update '+version;
     document.getElementById('release-line').hidden=false;return;
   }
 }
 }catch{}
})();
