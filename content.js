// ─────────────────────────────────────────────────────────────
//  content.js  –  Injected into https://mdirect.myntrainfo.com/*
//  Responsibilities:
//    1. Dynamically discover storePartnerIds / warehouseId / sellerId
//       by intercepting the /api/boot/mdirect API response
//    2. Inject a floating "Start Automation" button on the page
//    3. Capture auth headers / cookies from the live page session
//    4. Execute authenticated fetch() calls on behalf of background.js
//    5. Show a live progress panel on the page itself
// ─────────────────────────────────────────────────────────────

// ── § 1  Dynamic Config Discovery ────────────────────────────
//  Runs ONCE (guarded by __moaDynConfig) even across re-injections.
//  Hooks both fetch() and XMLHttpRequest so we capture the boot API
//  response whether it fires before or after the extension loads.
// ─────────────────────────────────────────────────────────────
if (!window.__moaDynConfig) {
  window.__moaDynConfig = {
    storePartnerIds: null,
    warehouseId: null,
    sellerId: null,
    discoveredFrom: null,   // which API URL populated the config
  };

  // ── Parse a JSON response and deeply absorb relevant fields ─
  function _moaParseResponse(url, json) {
    if (!json || typeof json !== 'object') return;

    function searchDeep(obj) {
      if (!obj || typeof obj !== 'object') return;

      _moaAbsorb(obj, url);

      // If we found everything, stop searching
      const c = window.__moaDynConfig;
      if (c.storePartnerIds && c.warehouseId && c.sellerId) return;

      // Recursive scan
      for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (typeof obj[key] === 'object' && obj[key] !== null) {
            searchDeep(obj[key]);
          }
        }
      }
    }

    searchDeep(json);
  }

  // ── Absorb config values from a flat object ────────────────
  function _moaAbsorb(obj, url) {
    const c = window.__moaDynConfig;

    // storePartnerIds — prefer storeMapping[].newId (from boot API)
    if (!c.storePartnerIds) {
      // 1) Check storeMapping array first (boot API structure)
      if (Array.isArray(obj.storeMapping) && obj.storeMapping.length) {
        const myntraStore = obj.storeMapping.find(s => s.name === 'myntra.com') || obj.storeMapping[0];
        const newId = myntraStore.newId ?? myntraStore.id;
        if (newId != null && !isNaN(parseInt(newId, 10)) && parseInt(newId, 10) !== -1) {
          c.storePartnerIds = [parseInt(newId, 10)];
          c.discoveredFrom = url;
        }
      }
      // 2) Fallback: storePartnerIds / partnerIds arrays
      if (!c.storePartnerIds) {
        const arrVal = obj.storePartnerIds || obj.partnerIds;
        const sglVal = obj.storePartnerId || obj.partnerId;
        if (Array.isArray(arrVal) && arrVal.length) {
          // Filter out -1 (wildcard/placeholder in config, not a real ID)
          const filtered = arrVal.map(Number).filter(v => v !== -1);
          if (filtered.length) {
            c.storePartnerIds = filtered;
            c.discoveredFrom = url;
          }
        } else if (sglVal != null && !isNaN(parseInt(sglVal, 10)) && parseInt(sglVal, 10) !== -1) {
          c.storePartnerIds = [parseInt(sglVal, 10)];
          c.discoveredFrom = url;
        }
      }
    }

    // warehouseId
    if (!c.warehouseId) {
      const wh = obj.warehouseId ?? obj.whId ?? obj.warehouseID;
      if (wh != null && !isNaN(parseInt(wh, 10))) {
        c.warehouseId = parseInt(wh, 10);
        c.discoveredFrom = url;
      }
    }

    // sellerId
    if (!c.sellerId) {
      const sid = obj.sellerId ?? obj.sellerPartnerId ?? obj.sellerID ?? obj.ownerId;
      if (sid != null) {
        c.sellerId = String(sid);
        c.discoveredFrom = url;
      }
    }
  }

  // ── Listen for messages from MAIN world ──────────────────────
  window.addEventListener('message', (event) => {
    // We only accept messages from ourselves
    if (event.source !== window || !event.data || event.data.source !== 'moa-hook') return;

    if (event.data.type === 'API_JSON') {
      _moaParseResponse(event.data.url, event.data.json);
    }
  });


}

// ── § 2  UI Injection (deferred until DOM is ready) ─────────
//  content_start runs at document_start (before DOMContentLoaded),
//  so we must wait for the DOM before touching document.body.
function _moaInitUI() {
  'use strict';

  // Prevent double-injection of UI
  if (window.__myntraAutomationInjected) return;
  window.__myntraAutomationInjected = true;

  // HTML escape utility to prevent XSS
  function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }


  // ─── Inject Floating UI ──────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.id = 'moa-fab-wrap';
  wrap.style.cssText = 'position:fixed;bottom:28px;right:28px;z-index:2147483647;display:flex;flex-direction:column;align-items:flex-end;gap:10px;font-family:Inter,system-ui,sans-serif;';
  wrap.innerHTML = `
    <!-- Panel -->
    <div id="moa-panel">
      <div id="moa-panel-header">
        <div class="moa-logo">D</div>
        <div>
          <div class="moa-title">Diwan Boutique</div>
          <div class="moa-sub">Myntra Direct · Order workspace</div>
        </div>
        <button id="moa-close" title="Close">✕</button>
      </div>

      <div id="moa-panel-body">
        <div class="moa-col-left">
          <div id="moa-picklist-row">
            <label for="moa-picklist-input">Picklist ID</label>
            <input id="moa-picklist-input" type="text" placeholder="OP20113317" title="Enter existing picklist barcode to skip Step 1">
            <fieldset id="moa-speed"><legend>Resume speed</legend>
              <label><input type="radio" name="moa-speed" value="normal"><span>Normal</span></label>
              <label><input type="radio" name="moa-speed" value="express"><span>Express</span></label>
              <label><input type="radio" name="moa-speed" value="faster"><span>Faster</span></label>
            </fieldset>
            <button disabled id="moa-resume-btn" title="Resume processing from existing picklist">Resume ▶</button>
          </div>

          <div class="moa-or-divider">── or generate new ──</div>

          <div id="moa-qty-row">
            <label for="moa-qty-input">📦 Orders:</label>
            <input id="moa-qty-input" type="number" min="1" max="9999" value="100" title="Number of orders for picklist">
          </div>

          <div id="moa-ordertype-row">
            <span class="moa-ot-label">📝 Type:</span>
            <label class="moa-radio-pill">
              <input type="radio" name="moa-ordertype" value="BOTH" checked>
              <span>Both</span>
            </label>
            <label class="moa-radio-pill">
              <input type="radio" name="moa-ordertype" value="SINGLE">
              <span>Single</span>
            </label>
            <label class="moa-radio-pill">
              <input type="radio" name="moa-ordertype" value="MULTI">
              <span>Multi</span>
            </label>
          </div>

          <div id="moa-btn-row">
            <button id="moa-start-btn">
              <div id="moa-spinner"></div>
              <span id="moa-start-icon">▶</span>
              <span id="moa-start-label">Start Automation</span>
            </button>
            <button id="moa-reset-btn" title="Reset">↺</button>
          </div>

          <div id="moa-steps">
            <div class="moa-step" id="moa-step-1">
              <div class="moa-step-num">1</div>
              <div class="moa-step-label">Generate Picklist</div>
              <div class="moa-step-icon">📋</div>
            </div>
            <div class="moa-step" id="moa-step-2">
              <div class="moa-step-num">2</div>
              <div class="moa-step-label">Fetch Picklist Status</div>
              <div class="moa-step-icon">🔍</div>
            </div>
            <div class="moa-step" id="moa-step-3">
              <div class="moa-step-num">3</div>
              <div class="moa-step-label">QC Pass</div>
              <div class="moa-step-icon">✅</div>
            </div>
            <div class="moa-step" id="moa-step-4">
              <div class="moa-step-num">4</div>
              <div class="moa-step-label">Mark Ready to Ship</div>
              <div class="moa-step-icon">📦</div>
            </div>
            <div class="moa-step" id="moa-step-5">
              <div class="moa-step-num">5</div>
              <div class="moa-step-label">Print Invoice &amp; Label</div>
              <div class="moa-step-icon">🖨️</div>
            </div>
          </div>
          

        </div>

        <div class="moa-col-right">
          <div id="moa-log-wrap">
            <div id="moa-log-head">📟 Activity Log</div>
            <div id="moa-log"><span style="color:#47656A;font-size:10.5px;">Awaiting start…</span></div>
          </div>
<button id="diwan-export" disabled>Excel available after batch completion</button>
          <div id="moa-product-card" style="display:none;"></div>
          <button id="moa-next-sku-btn" style="display:none;">▶ Process Next SKU</button>
          <div id="moa-cover-id-row" style="display:none;">
            <div class="moa-cid-title">📷 Scan Cover ID</div>
            <div class="moa-cid-form">
              <input id="moa-cover-id-input" type="text" placeholder="Scan or type cover barcode…" autofocus />
              <button id="moa-cover-id-submit">Confirm ✓</button>
            </div>
          </div>
        </div>
      </div>
    </div>

  `;

  // FAB is injected separately (fixed-position, not inside the wrap flex flow)
  const fabEl = document.createElement('button');
  fabEl.id = 'moa-fab';
  fabEl.title = 'Myntra Order Automation';
  fabEl.innerHTML = `
    <div id="moa-fab-badge"></div>
    <svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14a2 2 0 002 2h14a2 2 0 002-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg>
  `;

  connectBatchExport(wrap.querySelector('#diwan-export'));
  document.body.appendChild(wrap);
  document.body.appendChild(fabEl);

  // Backdrop overlay for centered panel
  const backdrop = document.createElement('div');
  backdrop.id = 'moa-backdrop';
  document.body.appendChild(backdrop);

  // ── UI wiring ───────────────────────────────────────────────
  const panel = document.getElementById('moa-panel');
  const fab = document.getElementById('moa-fab');
  const badge = document.getElementById('moa-fab-badge');
  const closeBtn = document.getElementById('moa-close');
  const startBtn = document.getElementById('moa-start-btn');
  const resetBtn = document.getElementById('moa-reset-btn');
  const logEl = document.getElementById('moa-log');
  const startLbl = document.getElementById('moa-start-label');
  const productCard = document.getElementById('moa-product-card');
  const nextSkuBtn = document.getElementById('moa-next-sku-btn');
  const coverIdRow = document.getElementById('moa-cover-id-row');
  const coverIdInput = document.getElementById('moa-cover-id-input');
  const coverIdSubmit = document.getElementById('moa-cover-id-submit');

  const qtyInput = document.getElementById('moa-qty-input');
  const picklistInput = document.getElementById('moa-picklist-input');
  const resumeBtn = document.getElementById('moa-resume-btn');

  const speeds=wrap.querySelector('#moa-speed');
  let resumeLocked=false;
  function refreshResume(){
    speeds.disabled=resumeLocked || !picklistInput.value.trim();
    resumeBtn.disabled=speeds.disabled || !speeds.querySelector('input:checked');
  }
  function lockResume(value){resumeLocked=value; refreshResume();}
  speeds.addEventListener('change',refreshResume);
  picklistInput.addEventListener('input',()=>{
    const checked=speeds.querySelector('input:checked');
    if(checked)checked.checked=false;
    refreshResume();
  });
  refreshResume();
  // Pointer events keep an ordinary tap separate from dragging.
  let gesture;
  let suppressClick = false;
  fab.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0) return;
    const rect = fab.getBoundingClientRect();
    gesture = {id:event.pointerId, x:event.clientX, y:event.clientY, left:rect.left, top:rect.top};
    suppressClick = false;
    fab.setPointerCapture(event.pointerId);
  });
  fab.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return;
    const dx=event.clientX-gesture.x, dy=event.clientY-gesture.y;
    if (!suppressClick && Math.hypot(dx,dy)<6) return;
    suppressClick=true;
    fab.classList.add('moa-dragging');
    fab.style.left=Math.max(0,Math.min(innerWidth-fab.offsetWidth,gesture.left+dx))+'px';
    fab.style.top=Math.max(0,Math.min(innerHeight-fab.offsetHeight,gesture.top+dy))+'px';
    fab.style.right=fab.style.bottom='auto';
  });
  fab.addEventListener('lostpointercapture', () => {gesture=null;fab.classList.remove('moa-dragging');});
  async function openPanel() {
      if (panel.classList.contains('open')) return;
      panel.classList.add('open');
      backdrop.classList.add('open');
      try {
        const licStatus = await new Promise((resolve) => {
          chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
            if (chrome.runtime.lastError) resolve({ licensed: false, message: 'Extension error.' });
            else resolve(resp || { licensed: false, message: 'No response.' });
          });
        });
        if (!licStatus.licensed) {
          addLog(`🔒 ${licStatus.message || 'Not logged in or subscription inactive. Open extension popup to login/renew.'}`, 'error');
          startBtn.disabled = true;
          lockResume(true);
          startLbl.textContent = '🔒 Locked';
        } else {
          // Authorized — ensure buttons are enabled (unless automation is running)
          if (!startBtn.classList.contains('loading')) {
            startBtn.disabled = false;
            lockResume(false);
            startLbl.textContent = 'Start Automation';
          }
        }
      } catch (_) { /* ignore — automation will re-check anyway */ }
  }
  fab.addEventListener('click', event => {
    if (event.detail && suppressClick) {suppressClick=false;return;}
    if (panel.classList.contains('open')) closeBtn.click();
    else openPanel();
  });
  chrome.runtime.onMessage.addListener((msg,_sender,reply) => {
    if (msg.action === 'OPEN_ORDER_PANEL') {
      openPanel();
      reply({opened:panel.classList.contains('open')});
    }
  });
  closeBtn.addEventListener('click', () => {
    panel.classList.remove('open');
    backdrop.classList.remove('open');
  });
  backdrop.addEventListener('click', () => {
    panel.classList.remove('open');
    backdrop.classList.remove('open');
  });

  function addLog(msg, type = 'info') {
    const empties = logEl.querySelectorAll('span[style]');
    empties.forEach(e => e.remove());

    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.className = `moa-log-line ${type}`;
    line.innerHTML = `<span class="moa-log-time">${time}</span><span class="moa-log-msg">${escHtml(msg)}</span>`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setStep(n, state) {
    const el = document.getElementById(`moa-step-${n}`);
    if (!el) return;
    el.classList.remove('active', 'done', 'failed');
    if (state) el.classList.add(state);
  }

  function resetAll() {
    for (let i = 1; i <= 5; i++) setStep(i, '');
    logEl.innerHTML = '<span style="color:#47656A;font-size:10.5px;">Awaiting start…</span>';
    startBtn.disabled = false;
    startBtn.classList.remove('loading');
    startLbl.textContent = 'Start Automation';
    badge.className = '';
    badge.textContent = '';
    if (productCard) productCard.style.display = 'none';
    if (nextSkuBtn) nextSkuBtn.style.display = 'none';
    if (coverIdRow) coverIdRow.style.display = 'none';
    if (resumeBtn) lockResume(false);
  }

  resetBtn.addEventListener('click', () => {
    if(startBtn.classList.contains('loading')){addLog('Batch is running. Reset is available after it ends.','info');return;}
    resetAll();
    chrome.runtime.sendMessage({ action: 'RESET' });
  });

  startBtn.addEventListener('click', async () => {
    if (startBtn.disabled) return;

    // ── License gate: check login + active subscription ──
    startBtn.disabled = true;
    startLbl.textContent = 'Verifying…';
    try {
      const licStatus = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
          if (chrome.runtime.lastError) resolve({ licensed: false, message: 'Extension error.' });
          else resolve(resp || { licensed: false, message: 'No response.' });
        });
      });
      if (!licStatus.licensed) {
        addLog(`🔒 ${licStatus.message || 'Not logged in or subscription expired. Open extension popup to login/renew.'}`, 'error');
        startBtn.disabled = false;
        startLbl.textContent = 'Start Automation';
        return;
      }
    } catch (e) {
      addLog(`🔒 License check failed: ${e.message}`, 'error');
      startBtn.disabled = false;
      startLbl.textContent = 'Start Automation';
      return;
    }

    // Read quantity from input (default 100, min 1)
    let quantity = parseInt(qtyInput.value, 10);
    if (isNaN(quantity) || quantity < 1) quantity = 100;
    qtyInput.value = quantity;

    // Read order type from radio buttons
    const orderType = wrap.querySelector('input[name="moa-ordertype"]:checked')?.value || 'BOTH';

    lockResume(true);
    startBtn.classList.add('loading');
    startLbl.textContent = 'Running…';
    badge.className = 'show';
    badge.textContent = '…';

    addLog(`🚀 Starting automation (${quantity} ${orderType.toLowerCase()} order${quantity > 1 ? 's' : ''})…`, 'step');

    await requestStart({quantity:String(quantity),orderType});
  });

  async function requestStart(options) {
    try {
      const reply=await chrome.runtime.sendMessage({action:'START_AUTOMATION',...options});
      if (!reply?.started) throw new Error(reply?.reason || 'No reply. Refresh the Myntra tab and reopen Order Automation.');
    } catch (error) {
      startBtn.disabled=false;lockResume(false);
      startBtn.classList.remove('loading');
      startLbl.textContent='Start Automation';
      badge.textContent='!';
      addLog(error.message,'error');
    }
  }
  // ── Resume Existing Picklist ────────────────────────────
  resumeBtn.addEventListener('click', async () => {
    if (resumeBtn.disabled) return;
    const picklistBarcode = (picklistInput?.value || '').trim();
    if (!picklistBarcode) {
      addLog('⚠ Please enter a picklist barcode (e.g. OP20113317)', 'warning');
      picklistInput.focus();
      return;
    }

    const speedMode=speeds.querySelector('input:checked')?.value;
    if(!speedMode)return;
    // ── License gate: check login + active subscription ──
    lockResume(true);
    try {
      const licStatus = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
          if (chrome.runtime.lastError) resolve({ licensed: false, message: 'Extension error.' });
          else resolve(resp || { licensed: false, message: 'No response.' });
        });
      });
      if (!licStatus.licensed) {
        addLog(`🔒 ${licStatus.message || 'Not logged in or subscription expired. Open extension popup to login/renew.'}`, 'error');
        lockResume(false);
        return;
      }
    } catch (e) {
      addLog(`🔒 License check failed: ${e.message}`, 'error');
      lockResume(false);
      return;
    }

    startBtn.disabled = true;
    startBtn.classList.add('loading');
    startLbl.textContent = 'Resuming…';
    badge.className = 'show';
    badge.textContent = '…';

    addLog(`🔄 Resuming from existing picklist: ${picklistBarcode}`, 'step');

    await requestStart({existingPicklistBarcode:picklistBarcode,speedMode});
  });

  // ── Next SKU button handler ─────────────────────────────
  if (nextSkuBtn) {
    nextSkuBtn.addEventListener('click', () => {
      nextSkuBtn.style.display = 'none';
      chrome.runtime.sendMessage({ action: 'NEXT_SKU_CONFIRMED' });
      addLog('▶ Proceeding to next SKU…', 'step');
    });
  }

  // ── Receive progress from background.js ───────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'LOG':
        addLog(msg.text, msg.level || 'info');
        break;
      case 'STEP_ACTIVE':
        setStep(msg.step, 'active');
        badge.className = 'show';
        badge.textContent = msg.step;
        break;
      case 'STEP_DONE':
        setStep(msg.step, 'done');
        break;
      case 'STEP_FAILED':
        setStep(msg.step, 'failed');
        badge.className = 'show error';
        badge.textContent = '!';
        break;
      case 'DONE':
        lockResume(false);
        startBtn.disabled = false;
        startBtn.classList.remove('loading');
        startLbl.textContent = 'Start Automation';
        badge.className = 'show';
        badge.textContent = '✓';
        addLog('🎉 All steps complete!', 'success');
        break;
      case 'ERROR':
        lockResume(false);
        startBtn.disabled = false;
        startBtn.classList.remove('loading');
        startLbl.textContent = 'Start Automation';
        addLog(`❌ ${msg.text}`, 'error');
        badge.className = 'show error';
        badge.textContent = '!';
        break;
      case 'LICENSE_INVALID':
        startBtn.disabled = true;
        lockResume(true);
        startBtn.classList.remove('loading');
        startLbl.textContent = '🔒 Locked';
        addLog(`🔒 ${msg.message || 'License invalid. Please login and ensure subscription is active.'}`, 'error');
        badge.className = 'show error';
        badge.textContent = '🔒';
        break;
      case 'SHOW_PRODUCT_CARD': {
        if (productCard) {
          const items = msg.items || [];
          const totalItems = msg.totalItems || items.length;
          const skuLabel = `SKU ${msg.currentSku || '?'}/${msg.totalSkus || '?'}`;
          const orderLabel = `Order #${msg.orderNumber || '?'}`;

          let html = `
            <div class="moa-pc-header">
              <span class="moa-pc-badge">${skuLabel}</span>
              <span class="moa-pc-order">${orderLabel}</span>
              <span class="moa-pc-qty">${totalItems} item${totalItems > 1 ? 's' : ''}</span>
            </div>
            <div class="moa-items-grid">
          `;

          items.forEach((item, idx) => {
            html += `
              <div class="moa-item-card" style="animation-delay:${idx * 0.08}s">
                <div class="moa-item-img-wrap">
                  <img class="moa-item-img" src="${escHtml(item.imageUrl || '')}" alt="${escHtml(item.productName || 'Product')}" onerror="this.style.display='none'" />
                  <span class="moa-item-num">#${idx + 1}</span>
                  ${item.size ? `<span class="moa-item-size">${escHtml(item.size)}</span>` : ''}
                </div>
                <div class="moa-item-details">
                  ${item.brand ? `<div class="moa-item-brand">${escHtml(item.brand)}</div>` : ''}
                  <div class="moa-item-name">${escHtml(item.productName || 'Unknown Product')}</div>
                  <div class="moa-item-sku-row">
                    <span class="moa-item-sku-label">Myntra:</span>
                    <span class="moa-item-sku-value">${escHtml(item.myntraSkuCode || '')}</span>
                  </div>
                  <div class="moa-item-sku-row">
                    <span class="moa-item-sku-label">Seller:</span>
                    <span class="moa-item-sku-value">${escHtml(item.sellerSkuCode || '')}</span>
                  </div>
                </div>
              </div>
            `;
          });

          html += '</div>';
          productCard.innerHTML = html;
          productCard.style.display = 'block';
        }
        break;
      }
      case 'HIDE_PRODUCT_CARD':
        if (productCard) productCard.style.display = 'none';
        break;
      case 'ASK_COVER_ID': {
        if (coverIdRow) {
          coverIdRow.style.display = 'block';
          if (coverIdInput) {
            coverIdInput.value = '';
            coverIdInput.placeholder = msg.defaultCoverId ? `Default: ${msg.defaultCoverId}` : 'Scan cover barcode…';
            setTimeout(() => coverIdInput.focus(), 100);
          }
          addLog(`📷 Scan Cover ID for order #${msg.orderNumber || '?'} (${msg.skuCode || ''})`, 'step');
        }
        break;
      }
      case 'HIDE_COVER_ID':
        if (coverIdRow) coverIdRow.style.display = 'none';
        break;
      case 'SHOW_NEXT_SKU_BTN': {
        if (nextSkuBtn) {
          nextSkuBtn.textContent = `▶ Process Next SKU (${msg.nextSkuCode || 'next'})`;
          nextSkuBtn.style.display = 'flex';
        }
        break;
      }
      case 'HIDE_NEXT_SKU_BTN':
        if (nextSkuBtn) nextSkuBtn.style.display = 'none';
        break;
      case 'SHOW_SUMMARY': {
        if (productCard) {
          const s = msg.summary || {};
          const breakdown = s.skuBreakdown || [];

          let tableRows = '';
          breakdown.forEach((sku, idx) => {
            tableRows += `
              <tr>
                <td style="text-align:center;color:#47656A;font-size:11px;">${idx + 1}</td>
                <td class="sku-code">${escHtml(sku.skuCode || '')}</td>
                <td style="font-size:11px;color:#47656A;">${escHtml(sku.sellerSkuCode || '')}</td>
                <td class="sku-orders">${sku.ordersProcessed || 0}</td>
              </tr>
            `;
          });

          let summaryHtml = `
            <div id="moa-summary-card">
              <div class="moa-summary-header">
                <span class="moa-summary-title">🎉 Processing Complete</span>
                <span class="moa-summary-time">⏱ ${escHtml(s.elapsedFormatted || '0s')}</span>
              </div>

              <div class="moa-summary-stats">
                <div class="moa-stat-card">
                  <div class="moa-stat-value accent">${s.totalOrders || 0}</div>
                  <div class="moa-stat-label">Total Orders</div>
                </div>
                <div class="moa-stat-card">
                  <div class="moa-stat-value green">${s.totalSkus || 0}</div>
                  <div class="moa-stat-label">Total SKUs</div>
                </div>
                <div class="moa-stat-card">
                  <div class="moa-stat-value blue">${s.singleItemOrders || 0}</div>
                  <div class="moa-stat-label">Single Item Orders</div>
                </div>
                <div class="moa-stat-card">
                  <div class="moa-stat-value yellow">${s.multiItemOrders || 0}</div>
                  <div class="moa-stat-label">Multi Item Orders</div>
                </div>
              </div>

              ${breakdown.length > 0 ? `
                <table class="moa-summary-table">
                  <thead>
                    <tr>
                      <th style="text-align:center;width:30px;">#</th>
                      <th>Myntra SKU</th>
                      <th>Seller SKU</th>
                      <th style="text-align:center;">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${tableRows}
                  </tbody>
                </table>
              ` : ''}

              ${s.picklistBarcode ? `
                <div class="moa-summary-picklist">
                  📋 Picklist: <strong>${escHtml(s.picklistBarcode)}</strong>
                </div>
              ` : ''}
            </div>
          `;

          productCard.innerHTML = summaryHtml;
          productCard.style.display = 'block';
        }
        break;
      }
    }
  });

  // ─────────────────────────────────────────────────────────────
  //  Auth & API helpers (used by background.js via messaging)
  // ─────────────────────────────────────────────────────────────
  function getAuthInfo() {
    const cookies = {};
    document.cookie.split(';').forEach(pair => {
      const [k, ...v] = pair.trim().split('=');
      if (k) cookies[k.trim()] = v.join('=');
    });

    const xsrf = cookies['x-myntra-xsrf-token'] || cookies['XSRF-TOKEN'] || '';

    let userLogin = '';
    try {
      for (const val of Object.values({ ...localStorage })) {
        try {
          const p = JSON.parse(val);
          if (p?.userLogin) { userLogin = p.userLogin; break; }
          if (p?.userId) { userLogin = p.userId; break; }
        } catch (_) { }
      }
    } catch (_) { }

    return { cookies, xsrf, userLogin };
  }

  async function callApi({ method = 'GET', url, body, extraHeaders = {}, skipBody = false }) {
    const { xsrf } = getAuthInfo();
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'x-myntra-xsrf-token': xsrf,
      ...extraHeaders
    };
    const opts = { method, headers, credentials: 'include' };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);

    const resp = await fetch(url, opts);

    // skipBody=true: don't read the response body (e.g. PDF blob downloads).
    // We only need the HTTP status to confirm the call succeeded.
    if (skipBody) {
      return { ok: resp.ok, status: resp.status, data: null };
    }

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = text; }
    return { ok: resp.ok, status: resp.status, data };
  }

  // Single consolidated message listener
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === 'FETCH_API') {
      callApi(msg.payload)
        .then(result => sendResponse({ success: true, result }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    if (msg.action === 'GET_AUTH_INFO') {
      try {
        sendResponse({ success: true, authInfo: getAuthInfo() });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
      return true;
    }

    // Return the dynamically discovered config values from the boot API
    if (msg.action === 'GET_DYNAMIC_CONFIG') {
      sendResponse({
        success: true,
        config: window.__moaDynConfig || {
          storePartnerIds: null,
          warehouseId: null,
          sellerId: null,
          discoveredFrom: null,
        },
      });
      return true;
    }
  });

  // ── Auto License Check on Page Load ─────────────────────────
  // Show a prominent notification banner if user is not logged in
  // or subscription is not active. Runs on every page load/reload.
  (function autoLicenseCheck() {
    // Create the notification banner element
    const banner = document.createElement('div');
    banner.id = 'moa-auth-banner';
    banner.innerHTML = `
      <div id="moa-auth-banner-header">
        <div class="moa-ab-icon">🔒</div>
        <div>
          <div class="moa-ab-title">Myntra Order Automation</div>
          <div class="moa-ab-sub">License Required</div>
        </div>
        <button id="moa-auth-banner-close" title="Dismiss">✕</button>
      </div>
      <div id="moa-auth-banner-body">
        <div id="moa-auth-banner-msg"></div>
        <div id="moa-auth-banner-actions">
          <button id="moa-auth-banner-open">🔑 Open Extension Popup</button>
          <button id="moa-auth-banner-dismiss">Dismiss</button>
        </div>
      </div>
    `;
    document.body.appendChild(banner);

    // Wire close/dismiss buttons
    const closeBannerBtn = banner.querySelector('#moa-auth-banner-close');
    const dismissBtn = banner.querySelector('#moa-auth-banner-dismiss');
    const openPopupBtn = banner.querySelector('#moa-auth-banner-open');

    function hideBanner() {
      banner.classList.remove('show');
    }
    closeBannerBtn.addEventListener('click', hideBanner);
    dismissBtn.addEventListener('click', hideBanner);

    // Open extension popup — since we can't programmatically open popup,
    // we send a message that will highlight the extension icon
    openPopupBtn.addEventListener('click', () => {
      // Try to open popup via chrome API (won't work from content script,
      // but we can show a helpful alert)
      hideBanner();
      alert('👆 Click the Myntra Order Automation extension icon in your browser toolbar (top-right puzzle piece icon) to login or renew your subscription.');
    });

    // Check license after a short delay (let the page settle)
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'GET_LICENSE_STATUS' }, (resp) => {
        if (chrome.runtime.lastError) return; // Extension context invalidated

        const msgEl = banner.querySelector('#moa-auth-banner-msg');
        const titleEl = banner.querySelector('.moa-ab-title');
        const subEl = banner.querySelector('.moa-ab-sub');
        const iconEl = banner.querySelector('.moa-ab-icon');

        if (!resp || !resp.licensed) {
          // Not logged in or subscription inactive
          const reason = resp?.message || 'Please login and ensure your subscription is active.';

          // Determine if it's a login issue or subscription issue
          const isLoginIssue = reason.toLowerCase().includes('not logged') || reason.toLowerCase().includes('login') || reason.toLowerCase().includes('re-login');
          const isExpired = reason.toLowerCase().includes('expired') || reason.toLowerCase().includes('renew');

          if (isLoginIssue) {
            iconEl.textContent = '🔑';
            titleEl.textContent = 'Login Required';
            subEl.textContent = 'Myntra Order Automation';
            msgEl.innerHTML = `<span class="moa-ab-highlight">You are not logged in.</span><br>Please open the extension popup and login with your account to use the automation tool.`;
            openPopupBtn.textContent = '🔑 Login Now';
          } else if (isExpired) {
            iconEl.textContent = '⏰';
            titleEl.textContent = 'Subscription Expired';
            subEl.textContent = 'Myntra Order Automation';
            banner.classList.add('expired');
            msgEl.innerHTML = `<span class="moa-ab-highlight">Your subscription has expired!</span><br>Please open the extension popup and renew your plan to continue using the automation tool.`;
            openPopupBtn.textContent = '💎 Renew Subscription';
          } else {
            iconEl.textContent = '🔒';
            titleEl.textContent = 'License Required';
            subEl.textContent = 'Myntra Order Automation';
            msgEl.textContent = reason;
            openPopupBtn.textContent = '🔑 Open Extension Popup';
          }

          banner.classList.add('show');

          // Also lock the FAB panel buttons
          if (startBtn) startBtn.disabled = true;
          if (resumeBtn) lockResume(true);
          if (startLbl) startLbl.textContent = '🔒 Locked';
        }
        // If licensed — do nothing, banner stays hidden
      });
    }, 2000); // 2 second delay to let extension service worker wake up
  })();


} // end _moaInitUI

// ── DOM-ready dispatcher ─────────────────────────────────────
//  document_start fires before DOMContentLoaded. Defer UI init
//  until the body exists so we can safely append elements.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _moaInitUI);
} else {
  // DOM already ready (e.g. re-injection after page loaded)
  _moaInitUI();
}
