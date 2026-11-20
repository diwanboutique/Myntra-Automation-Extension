// ─────────────────────────────────────────────────────────────
//  background.js  –  Service Worker (Manifest V3)
//  Orchestrates the full Myntra order-processing pipeline:
//
//  Step 1 → Generate Picklist
//  Step 2 → Fetch Picklist Status / Details
//  Step 3 → QC Pass
//  Step 4 → Mark Ready-to-Ship
//  Step 5 → Print Invoice & Shipping Label
// ─────────────────────────────────────────────────────────────
'use strict';
importScripts('pdf-fields.js','pdf-lib.min.js','archive.js','print-pair.js','license-config.js','license-client.js','order-details.js','report.js', 'identity.js', 'qz-tray.js', 'local-qz.js');


// ── State ─────────────────────────────────────────────────────
let automationState = {
  running: false,
  tabId: null,
};

// ── Next SKU pause/resume mechanism ──────────────────────
let nextSkuResolver = null;
function waitForNextSku() {
  return new Promise(resolve => {
    nextSkuResolver = resolve;
  });
}

// ── Cover ID scan pause/resume mechanism ─────────────────
let coverIdResolver = null;
function waitForCoverId() {
  return new Promise(resolve => {
    coverIdResolver = resolve;
  });
}

// ── Communication helpers ─────────────────────────────────────
// Broadcasts to BOTH the popup (if open) AND the content script tab
function broadcast(msg) {
  // → popup
  chrome.runtime.sendMessage(msg).catch(() => { });
  // → content script FAB panel (if a Myntra tab is active)
  if (automationState.tabId) {
    chrome.tabs.sendMessage(automationState.tabId, msg).catch(() => { });
  }
}
function log(text, level = 'info') {
  broadcast({ type: 'LOG', text, level });
}
function stepActive(n) { broadcast({ type: 'STEP_ACTIVE', step: n }); }
function stepDone(n) { broadcast({ type: 'STEP_DONE', step: n }); }
function stepFailed(n) { broadcast({ type: 'STEP_FAILED', step: n }); }
function done() { broadcast({ type: 'DONE' }); }
function error(text) { broadcast({ type: 'ERROR', text }); }

// ── Delay ─────────────────────────────────────────────────────
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Service Worker Keep-Alive ───────────────────────────────
// MV3 service workers go idle after ~30s. We use chrome.alarms
// to keep the worker alive during active automation.
function startKeepAlive() {
  chrome.alarms.create('moa-keep-alive', { periodInMinutes: 0.4 }); // ~24s
}
function stopKeepAlive() {
  chrome.alarms.clear('moa-keep-alive');
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'moa-keep-alive' && automationState.running) {
    // Intentional no-op — just waking the worker is enough
  }
});

// ── Proxy API calls through the content script ───────────────
// The content script runs in the page's cookie/auth context so
// every fetch() it makes automatically includes session cookies.
function closedPicklistMessage(message) {
  return /^invalid picklist status:\s*closed(?:\s*\[genie\])?$/i.test(String(message || '').trim());
}
async function apiCall(tabId, method, url, body = null, extraHeaders = {}, skipBody = false) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tabId,
      {
        action: 'FETCH_API',
        payload: { method, url, body, extraHeaders, skipBody }
      },
      (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (!response) {
          return reject(new Error('No response from content script. Is the Myntra tab open?'));
        }
        if (!response.success) {
          return reject(new Error(response.error || 'Content script fetch failed'));
        }
        const r = response.result;
        if (!r.ok) {
          const err = new Error(`HTTP ${r.status} from ${url}`);
          err.apiStatus = r.data?.status;
          return reject(err);
        }
        resolve(r.data);
      }
    );
  });
}

// ── Get auth info from content script ────────────────────────
async function getAuthInfo(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: 'GET_AUTH_INFO' }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.success) return reject(new Error('Cannot get auth info'));
      resolve(response.authInfo);
    });
  });
}

// ── Ensure content script is injected ────────────────────────
async function ensureContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['export-control.js','content.js']
    });
  } catch (_) {
    // Already injected – fine
  }
}

// ── Default configuration (overridden by dynamic discovery + user settings) ──
const CONFIG = {
  storePartnerIds: null,   // Discovered dynamically from Myntra boot API
  warehouseId: null,       // Discovered dynamically from Myntra boot API
  sellerId: null,          // Discovered dynamically from Myntra boot API
  quantity: '100',
  orderType: 'BOTH',
  priority: false,
  invoicePrinter: 'TSC DA310',
  labelPrinter: 'TSC DA310',
  defaultCoverId: 'myntra123',
  askCoverIdPerOrder: false,
};

// Common Myntra-specific request headers
const MYNTRA_HEADERS = {
  'x-myntra-app-name': 'mdirect',
  'x-myntra-client-id': 'mdirect',
  'x-myntra-mdirect-service': 'genie.orders.generatePicklist',
  'x-requested-with': 'XMLHttpRequest',
  'origin': 'https://mdirect.myntrainfo.com',
  'referer': 'https://mdirect.myntrainfo.com/',
};

async function runAutomation({ tabId, delay: stepDelay, quantity, orderType, existingPicklistBarcode, speedMode }) {
  // ── License Gate ─────────────────────────────────────────────
  await requireLicense(!!existingPicklistBarcode);
  log('License active', 'success');

  // Load saved config from chrome.storage.local (set by popup)
  const stored = await chrome.storage.local.get('moaConfig');
  const savedConfig = stored.moaConfig || {};

  const invoicePrinter = savedConfig.invoicePrinter || CONFIG.invoicePrinter;
  const labelPrinter = savedConfig.labelPrinter || CONFIG.labelPrinter;
  const defaultCoverId = savedConfig.defaultCoverId || CONFIG.defaultCoverId;
  const askCoverIdPerOrder = savedConfig.askCoverIdPerOrder ?? CONFIG.askCoverIdPerOrder;
  stepDelay = savedConfig.stepDelay || stepDelay || 1500;
  const pauseOnSkuChange = savedConfig.pauseOnSkuChange ?? true;
  let archiveFolder;

  if(existingPicklistBarcode){
    if(!['normal','express','faster'].includes(speedMode))throw Error('Choose Normal, Express or Faster before Resume.');
    const maxWait = {normal: 300, express: 60, faster: 0};
    stepDelay = Math.min(stepDelay, maxWait[speedMode]);
    log('Resume mode: '+speedMode+' · step wait '+stepDelay+' ms','info');
  }
  quantity = quantity || CONFIG.quantity;
  orderType = orderType || CONFIG.orderType;
  existingPicklistBarcode = (existingPicklistBarcode || '').trim();
  automationState.running = true;
  automationState.tabId = tabId;

  // ── Ask for Print Permission (Batch Level) ───────────────────
  let batchPrintPermission = 'all';
  try {
    const permissionResult = await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        return new Promise((resolve) => {
          const overlay = document.createElement('div');
          overlay.className = 'diwan-dialog';
          overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;';
          
          const modal = document.createElement('div');
          modal.style.cssText = 'background:#fff;border:3px solid #0F282F;border-radius:12px;padding:30px;width:400px;max-width:90%;box-shadow:8px 8px 0 #0F282F;font-family:system-ui,-apple-system,sans-serif;color:#0F282F;text-align:center;';
          
          modal.innerHTML = `
            <div style="font-size:40px;margin-bottom:15px">🖨️</div>
            <h2 style="margin:0 0 15px 0;font-size:22px;font-weight:800;text-transform:uppercase;">Print Permission</h2>
            <p style="margin-bottom:25px;font-size:15px;color:#444;font-weight:500;">How would you like to print?</p>
            <div style="display:flex;gap:15px;justify-content:center;">
              <button id="moa-print-single-btn" style="flex:1;background:#fff;color:#0F282F;border:2px solid #0F282F;padding:12px;font-weight:700;border-radius:6px;cursor:pointer;box-shadow:4px 4px 0 #0F282F;transition:transform 0.1s;text-transform:uppercase;">Print Single</button>
              <button id="moa-print-all-btn" style="flex:1;background:#4CAF50;color:#0F282F;border:2px solid #0F282F;padding:12px;font-weight:700;border-radius:6px;cursor:pointer;box-shadow:4px 4px 0 #0F282F;transition:transform 0.1s;text-transform:uppercase;">Print All</button>
            </div>
            <div style="margin-top:20px;font-size:12px;color:#666;text-align:left;">
              <b>Print Single:</b> Ask for confirmation before printing each order.<br><br>
              <b>Print All:</b> Continuously print all orders automatically without asking again.
            </div>
          `;
          
          overlay.appendChild(modal);
          document.body.appendChild(overlay);
          
          const singleBtn = document.getElementById('moa-print-single-btn');
          const allBtn = document.getElementById('moa-print-all-btn');
          
          const addPressEffect = (btn) => {
            btn.onmousedown = () => { btn.style.transform = 'translate(2px, 2px)'; btn.style.boxShadow = '2px 2px 0 #0F282F'; };
            btn.onmouseup = () => { btn.style.transform = ''; btn.style.boxShadow = '4px 4px 0 #0F282F'; };
            btn.onmouseleave = () => { btn.style.transform = ''; btn.style.boxShadow = '4px 4px 0 #0F282F'; };
          };
          addPressEffect(singleBtn);
          addPressEffect(allBtn);
          
          singleBtn.onclick = () => { document.body.removeChild(overlay); resolve('single'); };
          allBtn.onclick = () => { document.body.removeChild(overlay); resolve('all'); };
        });
      }
    });
    batchPrintPermission = permissionResult?.[0]?.result || 'all';
    log(`▶ Batch print permission: ${batchPrintPermission.toUpperCase()}`, 'info');
  } catch (e) {
    log(`⚠ Could not ask for print permission, defaulting to PRINT ALL: ${e.message}`, 'warning');
    batchPrintPermission = 'all';
  }

  // ── Summary tracking ────────────────────────────────────────
  const summaryData = {
    startTime: Date.now(),
    endTime: null,
    picklistBarcode: '',
    totalOrders: 0,
    totalSkus: 0,
    singleItemOrders: 0,
    multiItemOrders: 0,
    skuBreakdown: [], // { skuCode, sellerSkuCode, ordersProcessed }
  };

  // Check if printer is PDF auto-save mode (supports macOS, Windows, Linux)
  function isPdfPrinter(printerName) {
    if (!printerName) return false;
    const p = printerName.toLowerCase();
    return p.includes('pdf') || p.includes('save as') || p.includes('save to') || p.includes('print to file') || p.includes('preview');
  }

  const invoiceIsPdf = isPdfPrinter(invoicePrinter);
  const labelIsPdf = isPdfPrinter(labelPrinter);

  log(`⚙ Config: Invoice→"${invoicePrinter}" | Label→"${labelPrinter}" | CoverID→"${defaultCoverId}" | ScanPerOrder→${askCoverIdPerOrder} | PauseOnSKU→${pauseOnSkuChange}`, 'info');

  try {
    startKeepAlive();
    if (invoiceIsPdf || labelIsPdf || savedConfig.archiveOrders) archiveFolder = await getArchiveFolder();
    if (!invoiceIsPdf || !labelIsPdf) await connectLocalPrinter();
    // Make sure content script is alive in the target tab
    await ensureContentScript(tabId);
    log('🔗 Content script ready.', 'info');

    // ── Resolve effective config (dynamic from boot API → static fallback) ─
    log('🔍 Resolving dynamic config from boot API…', 'info');

    let effectiveConfig = { ...CONFIG };

    await new Promise(resolve => {
      chrome.tabs.sendMessage(tabId, { action: 'GET_DYNAMIC_CONFIG' }, (resp) => {
        if (chrome.runtime.lastError || !resp?.success) {
          log('⚠ Could not get dynamic config; using static CONFIG values.', 'warning');
          return resolve();
        }

        const dyn = resp.config;

        if (dyn.storePartnerIds) {
          effectiveConfig.storePartnerIds = dyn.storePartnerIds;
          log(`✅ storePartnerIds → [${dyn.storePartnerIds}] (from boot API)`, 'success');
        } else if (!effectiveConfig.storePartnerIds) {
          log('⚠ storePartnerIds not discovered — will fail if not available', 'warning');
        }

        if (dyn.warehouseId) {
          effectiveConfig.warehouseId = dyn.warehouseId;
          log(`✅ warehouseId → ${dyn.warehouseId} (from boot API)`, 'success');
        } else if (!effectiveConfig.warehouseId) {
          log('⚠ warehouseId not discovered — will fail if not available', 'warning');
        }

        if (dyn.sellerId) {
          effectiveConfig.sellerId = dyn.sellerId;
          log(`✅ sellerId → ${dyn.sellerId} (from boot API)`, 'success');
        } else if (!effectiveConfig.sellerId) {
          log('⚠ sellerId not discovered — will fail if not available', 'warning');
        }

        if (dyn.discoveredFrom) {
          log(`  📡 Discovered from: ${dyn.discoveredFrom.replace('https://partnersapi.myntrainfo.com', '')}`, 'info');
        }

        resolve();
      });
    });

    if (!effectiveConfig.storePartnerIds || !effectiveConfig.warehouseId || !effectiveConfig.sellerId) {
      throw new Error(
        'Missing Warehouse ID or Seller ID. Please navigate to the "Orders" or "Pending Orders" tab in Myntra so the extension can detect your account details, then try again.'
      );
    }

    // Grab user login from session (best-effort)

    let userLogin = '';
    try {
      const authInfo = await getAuthInfo(tabId);
      userLogin = authInfo.userLogin || '';
      if (userLogin) log(`👤 Detected userLogin: ${userLogin}`, 'info');
      else log('⚠ userLogin not found in session; payload will omit it.', 'warning');
    } catch (e) {
      log(`⚠ Auth info error: ${e.message}`, 'warning');
    }

    // ── Determine picklist barcode ─────────────────────────────
    // If user provided an existing picklist barcode, skip Step 1 + 1b entirely.
    let picklistBarcode;

    if (existingPicklistBarcode) {
      // ── RESUME MODE: Use existing picklist ──────────────────
      picklistBarcode = existingPicklistBarcode;
      log(`📋 Using existing picklist barcode: ${picklistBarcode}`, 'step');
      log(`⏩ Skipping Step 1 (Generate Picklist) — already generated.`, 'info');
      stepDone(1);
    } else {
      // ── STEP 1: Generate Picklist ─────────────────────────────
      stepActive(1);
      log(`📋 Step 1 → Generating picklist for ${quantity} ${orderType.toLowerCase()} order(s)…`, 'step');

      const picklistUrl = 'https://partnersapi.myntrainfo.com/api/mdirect/orders/generatePicklist';
      const picklistBody = {
        pickListCreationRequest: {
          quantity: quantity,
          storePartnerIds: effectiveConfig.storePartnerIds,
          orderType: orderType,
          priority: effectiveConfig.priority,
        },
        warehouseId: effectiveConfig.warehouseId,
      };

      log(`  → PUT ${picklistUrl}`, 'info');
      log(`  → Body: ${JSON.stringify(picklistBody)}`, 'info');

      let picklistData;
      try {
        picklistData = await apiCall(tabId, 'PUT', picklistUrl, picklistBody, MYNTRA_HEADERS);
      } catch (e) {
        stepFailed(1);
        throw new Error(`Step 1 (Generate Picklist) failed: ${e.message}`);
      }

      const picklistResp = picklistData?.orderPickListResponse;
      if (!picklistResp) {
        stepFailed(1);
        throw new Error(`Step 1: Unexpected response – ${JSON.stringify(picklistData).slice(0, 200)}`);
      }

      const statusCode = picklistResp?.status?.statusCode;
      if (statusCode !== 3) {
        stepFailed(1);
        throw new Error(`Step 1 failed: ${picklistResp?.status?.statusMessage || 'Unknown error'} (code ${statusCode})`);
      }

      const picklistId = picklistResp.data?.orderPicklist?.id;
      picklistBarcode = picklistResp.data?.orderPicklist?.barcode;
      if (!picklistBarcode || !picklistId) {
        stepFailed(1);
        throw new Error('Step 1: Could not extract barcode/id from response');
      }

      log(`✅ Picklist created → id: ${picklistId}, barcode: ${picklistBarcode}`, 'success');
      stepDone(1);
    }

    await delay(stepDelay);

    // ── STEP 1b: Download & Parse Picklist PDF ─────────────────
    // The downloadPicklist API returns a PDF containing product details:
    // Myntra Sku Code | Seller Sku Code | Product Description | Quantity | Expiry Dates
    // We parse this PDF to extract structured product data.
    if (!existingPicklistBarcode) {
      log('📥 Step 1b → Downloading & parsing picklist PDF…', 'step');
      const downloadUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/downloadPicklist/${picklistBarcode}`;

      let picklistProducts = []; // Will hold parsed product rows from PDF

      try {
        // Get XSRF token for authenticated fetch
        let dlXsrf = '';
        try {
          const authInfo = await getAuthInfo(tabId);
          dlXsrf = authInfo.xsrf || '';
        } catch (_) { }

        const pdfParseResults = await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: async (downloadUrl, xsrfToken, pdfJsUrl, pdfWorkerUrl) => {

            // ── Load pdf.js library if not already loaded ──
            async function ensurePdfJs() {
              if (typeof pdfjsLib !== 'undefined') return;
              await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = pdfJsUrl;
                script.onload = resolve;
                script.onerror = () => reject(new Error('Failed to load pdf.js'));
                document.head.appendChild(script);
              });
              // Wait for pdfjsLib to be available
              for (let i = 0; i < 20; i++) {
                if (typeof pdfjsLib !== 'undefined') break;
                await new Promise(r => setTimeout(r, 200));
              }
              if (typeof pdfjsLib === 'undefined') {
                throw new Error('pdf.js library did not initialize');
              }
              // Set worker source
              pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
            }

            try {
              // Fetch the PDF blob
              const resp = await fetch(downloadUrl, {
                credentials: 'include',
                headers: {
                  'accept': '*/*',
                  'x-myntra-xsrf-token': xsrfToken,
                  'x-myntra-app-name': 'mdirect',
                  'x-myntra-client-id': 'mdirect',
                  'x-myntra-knuth': 'yes',
                  'x-requested-with': 'XMLHttpRequest',
                  'origin': 'https://mdirect.myntrainfo.com',
                  'referer': 'https://mdirect.myntrainfo.com/',
                },
              });
              if (!resp.ok) throw new Error(`HTTP ${resp.status} from downloadPicklist`);

              const arrayBuffer = await resp.arrayBuffer();

              // Load pdf.js
              await ensurePdfJs();

              // Parse the PDF
              const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
              const allText = [];

              for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                const items = textContent.items.map(item => ({
                  text: item.str.trim(),
                  x: Math.round(item.transform[4]),
                  y: Math.round(item.transform[5]),
                })).filter(item => item.text);
                allText.push(...items);
              }

              // ── Column-based PDF table parser ──────────────────────
              // This handles multi-line wrapped text in cells.
              //
              // Strategy:
              //   1. Find header items containing "Myntra Sku" → get column X boundaries
              //   2. Find "Total Quantity" Y → end boundary
              //   3. Collect all text items in between (the data zone)
              //   4. Assign each item to a column based on X position
              //   5. Detect product row boundaries using Myntra SKU Code pattern
              //      (uppercase letters followed by digits, e.g. MOVRWTCH130740555)
              //   6. Within each row, join multi-line text per column

              // Step 1: Find all header-related text items
              // Header may span 2 lines ("Seller Sku\nCode", "Expiry\nDates")
              // Find the Y zone that contains "Myntra" keyword
              let headerMinY = Infinity, headerMaxY = -Infinity;
              for (const it of allText) {
                if (it.text.includes('Myntra') && it.text.includes('Sku')) {
                  headerMinY = Math.min(headerMinY, it.y);
                  headerMaxY = Math.max(headerMaxY, it.y);
                }
              }

              if (headerMinY === Infinity) {
                const rawText = allText.map(it => it.text).join(' ');
                return { ok: true, products: [], rawText: rawText.slice(0, 500), method: 'no_header' };
              }

              // Expand header zone ±20px to catch wrapped header text like "Seller Sku\nCode"
              headerMinY -= 20;
              headerMaxY += 5;

              // Collect header items to determine column X boundaries
              const headerItems = allText.filter(it => it.y >= headerMinY && it.y <= headerMaxY);

              // Determine 5 column left-X boundaries from header items
              // Known columns: Myntra Sku Code | Seller Sku Code | Product Description | Quantity | Expiry Dates
              // Group header items by X proximity (within 30px = same column)
              const colXGroups = [];
              const sortedHeader = [...headerItems].sort((a, b) => a.x - b.x);
              for (const it of sortedHeader) {
                const existing = colXGroups.find(g => Math.abs(g.x - it.x) < 30);
                if (existing) {
                  existing.x = Math.min(existing.x, it.x); // use leftmost X
                } else {
                  colXGroups.push({ x: it.x });
                }
              }
              colXGroups.sort((a, b) => a.x - b.x);

              // We expect 5 columns
              const colBoundaries = colXGroups.map(g => g.x);

              // Step 2: Find "Total Quantity" Y position (end of data)
              let totalQtyY = -Infinity;
              for (const it of allText) {
                if (it.text.includes('Total') && it.text.includes('Quantity')) {
                  totalQtyY = it.y;
                  break;
                }
              }
              // Also check for items with just "Total"
              if (totalQtyY === -Infinity) {
                for (const it of allText) {
                  if (it.text === 'Total') {
                    totalQtyY = it.y;
                    break;
                  }
                }
              }

              // Step 3: Collect data items (below header, above "Total Quantity")
              // In PDF coords: header has higher Y, data has lower Y, total has even lower Y
              const dataItems = allText.filter(it => {
                if (it.y >= headerMinY) return false;         // above/in header
                if (totalQtyY !== -Infinity && it.y <= totalQtyY) return false; // at/below total
                return true;
              });

              if (dataItems.length === 0) {
                return { ok: true, products: [], rawText: 'No data items found between header and total', method: 'no_data' };
              }

              // Step 4: Assign each data item to a column based on X position
              function getColIndex(x) {
                for (let c = colBoundaries.length - 1; c >= 0; c--) {
                  if (x >= colBoundaries[c] - 15) return c;
                }
                return 0;
              }

              // Step 5: Detect product rows using column 0 (Myntra SKU Code)
              // Pattern: uppercase letters followed by digits, e.g. MOVRWTCH130740555
              const skuPattern = /^[A-Z]{2,}[0-9]{5,}$/;

              // Sort data items by Y descending (top to bottom in PDF)
              dataItems.sort((a, b) => b.y - a.y);

              // Find row start Y positions: items in col 0 matching SKU pattern
              const rowStarts = []; // { y, skuText }
              for (const it of dataItems) {
                const col = getColIndex(it.x);
                if (col === 0 && skuPattern.test(it.text)) {
                  rowStarts.push({ y: it.y, skuText: it.text });
                }
              }

              if (rowStarts.length === 0) {
                // Fallback: try to detect rows by first column items
                const col0Items = dataItems.filter(it => getColIndex(it.x) === 0);
                if (col0Items.length > 0) {
                  // Use first item in col 0 as a row start
                  rowStarts.push({ y: col0Items[0].y, skuText: col0Items[0].text });
                }
              }

              // Step 6: Build products — for each row, collect items per column
              const products = [];
              for (let r = 0; r < rowStarts.length; r++) {
                const rowTopY = rowStarts[r].y + 5; // slight buffer above
                const rowBottomY = r < rowStarts.length - 1
                  ? rowStarts[r + 1].y + 5          // next row start
                  : (totalQtyY !== -Infinity ? totalQtyY : -Infinity);

                // Collect items belonging to this row's Y range
                const rowItems = dataItems.filter(it =>
                  it.y <= rowTopY && it.y > rowBottomY
                );

                // Group by column, sort each column's items by Y (top to bottom)
                const colTexts = new Array(colBoundaries.length).fill('');
                const colItemsByCol = {};
                for (const it of rowItems) {
                  const col = getColIndex(it.x);
                  if (!colItemsByCol[col]) colItemsByCol[col] = [];
                  colItemsByCol[col].push(it);
                }

                for (const col in colItemsByCol) {
                  // Sort by Y descending (top to bottom in PDF) then X
                  colItemsByCol[col].sort((a, b) => b.y - a.y || a.x - b.x);
                  colTexts[col] = colItemsByCol[col].map(it => it.text).join(' ');
                }

                products.push({
                  myntraSkuCode: colTexts[0] || '',
                  sellerSkuCode: colTexts[1] || '',
                  productDescription: colTexts[2] || '',
                  quantity: parseInt(colTexts[3]) || 1,
                  expiryDate: colTexts[4] || 'N/A',
                });
              }

              return { ok: true, products, colCount: colBoundaries.length, method: 'column_based' };
            } catch (err) {
              return { ok: false, error: err.message };
            }
          },
          args: [downloadUrl, dlXsrf, chrome.runtime.getURL('pdfjs/pdf.min.js'), chrome.runtime.getURL('pdfjs/pdf.worker.min.js')],
        });

        const pdfResult = pdfParseResults?.[0]?.result;

        if (pdfResult?.ok && pdfResult.products?.length > 0) {
          picklistProducts = pdfResult.products;
          log(`✅ Picklist PDF parsed → ${picklistProducts.length} product(s) found:`, 'success');
          for (const prod of picklistProducts) {
            log(`   📦 ${prod.myntraSkuCode} | ${prod.sellerSkuCode} | ${prod.productDescription} | Qty: ${prod.quantity}`, 'info');
          }
        } else if (pdfResult?.ok) {
          log(`⚠ PDF parsed but no product rows extracted (method: ${pdfResult.method})`, 'warning');
          if (pdfResult.rawText) {
            log(`  📋 Raw PDF text: ${pdfResult.rawText}`, 'info');
          }
        } else {
          log(`⚠ PDF parse warning: ${pdfResult?.error || 'Unknown error'}`, 'warning');
        }

        log(`✅ downloadPicklist succeeded → picklist INITIATED`, 'success');
      } catch (e) {
        // Non-fatal: log the warning but continue to Step 2
        log(`⚠ downloadPicklist/PDF parse warning (non-fatal): ${e.message}`, 'warning');
      }
    } else {
      log(`⏩ Skipping Step 1b (PDF parse) — using existing picklist.`, 'info');
    }
    await delay(Math.floor(stepDelay / 2));

    // ── STEP 2: Fetch SKU Mapping from Packets API ─────────────
    stepActive(2);
    log(`🔍 Step 2 → Fetching SKU mapping from packets API for barcode: ${picklistBarcode}…`, 'step');

    const packetsUrl = `https://partnersapi.myntrainfo.com/api/mdirect/packets/${picklistBarcode}`;
    const packetsHeaders = {
      'x-myntra-app-name': 'mdirect',
      'x-myntra-client-id': 'mdirect',
      'x-myntra-mdirect-service': 'genie.orders.getPicklist',
      'x-requested-with': 'XMLHttpRequest',
      'origin': 'https://mdirect.myntrainfo.com',
      'referer': 'https://mdirect.myntrainfo.com/',
    };

    let sellarskuMyntrasku = {};
    try {
      const packetsData = await apiCall(tabId, 'GET', packetsUrl, null, packetsHeaders);
      sellarskuMyntrasku = packetsData?.sellarsku_myntrasku || {};

      if (Object.keys(sellarskuMyntrasku).length === 0) {
        stepFailed(2);
        throw new Error('Step 2: No sellarsku_myntrasku mapping found in packets response');
      }

      log(`✅ SKU mapping found → ${Object.keys(sellarskuMyntrasku).length} SKU(s):`, 'success');
      for (const [sellerSku, myntraSku] of Object.entries(sellarskuMyntrasku)) {
        log(`   📦 Seller: ${sellerSku} → Myntra: ${myntraSku}`, 'info');
      }
    } catch (e) {
      if (e.message.startsWith('Step 2:')) throw e;
      stepFailed(2);
      throw new Error(`Step 2 (Packets API) failed: ${e.message}`);
    }

    // Build SKU list from the sellarsku_myntrasku mapping
    const skuList = Object.entries(sellarskuMyntrasku).map(([sellerSkuCode, myntraSkuCode]) => ({
      sellerSkuCode,
      myntraSkuCode,
    }));

    log(`📦 Total SKUs to process: ${skuList.length}`, 'info');
    stepDone(2);
    await delay(stepDelay);

    // ── SKU-by-SKU Processing (Dynamic Packet Discovery) ─────
    // For each SKU, repeatedly call the items API to discover packets
    // one-by-one, process (QC → RTS → Print), and loop until CLOSED.
    const qcUrl = 'https://partnersapi.myntrainfo.com/api/mdirect/packets/items/qcpass';

    // Pre-fetch XSRF token and storePartnerId for printing
    let xsrfToken = '';
    try {
      const authInfo = await getAuthInfo(tabId);
      xsrfToken = authInfo.xsrf || '';
    } catch (_) { }
    const storePartnerId = effectiveConfig.storePartnerIds[0];

    const itemsHeaders = {
      'x-myntra-app-name': 'mdirect',
      'x-myntra-client-id': 'mdirect',
      'x-myntra-mdirect-service': 'genie.orders.getPacketAndStyleDetailsByPicklistAndSku',
      'x-requested-with': 'XMLHttpRequest',
      'origin': 'https://mdirect.myntrainfo.com',
      'referer': 'https://mdirect.myntrainfo.com/',
    };

    // ── STEP 3: Process orders for each SKU ────────────────────
    let globalOrderCounter = 0;
    const targetQuantity = parseInt(quantity, 10) || 1;
    const draftKey = 'diwanDraft:'+JSON.stringify([effectiveConfig.sellerId,picklistBarcode]);
    const draft = (await chrome.storage.local.get(draftKey))[draftKey] || {rows:[],pending:[]};
    const rows = draft.rows;
    const pending = new Set(draft.pending);
    const saveDraft = () => chrome.storage.local.set({[draftKey]:{rows,pending:[...pending]}});
    const seenOrders = new Set();

    const processedPacketIds = new Set(); // Track processed packets to prevent duplicates
    summaryData.picklistBarcode = picklistBarcode;
    const isResumeMode = !!existingPicklistBarcode;

    let picklistClosed = false;
    for (let skuIdx = 0; skuIdx < skuList.length; skuIdx++) {
      const currentSku = skuList[skuIdx];
      const skuCode = currentSku.myntraSkuCode;
      const sellerSkuCodeFromMapping = currentSku.sellerSkuCode;
      let repeatedPackets = 0;
      let orderCounter = 0;
      let ordersProcessedForThisSku = 0;

      log(`\n─────────────────────────────────────────`, 'info');
      log(`🔄 SKU ${skuIdx + 1}/${skuList.length}: ${skuCode} (Seller: ${sellerSkuCodeFromMapping})`, 'step');

      // ── Inner loop: process all orders for this SKU until CLOSED ──
      while (true) {
        orderCounter++;
        log(`\n  ── Order #${orderCounter} for ${skuCode} ──`, 'info');

        // Call items API to discover the next packet for this SKU
        const itemsUrl = `https://partnersapi.myntrainfo.com/api/mdirect/packets/${picklistBarcode}/items?skuCode=${encodeURIComponent(skuCode)}&warehouseId=${effectiveConfig.warehouseId}`;

        let itemsData;
        let itemsRetries = 0;
        const MAX_ITEMS_RETRIES = 10;
        while (true) {
          try {
            itemsData = await apiCall(tabId, 'GET', itemsUrl, null, itemsHeaders);
          } catch (e) {
            if (closedPicklistMessage(e.apiStatus?.statusMessage) || closedPicklistMessage(e.message)) {
              itemsData={status:{statusMessage:e.apiStatus?.statusMessage || e.message}};
              break;
            }
            itemsRetries++;
            if (itemsRetries >= MAX_ITEMS_RETRIES) {
              log(`  ⚠ Items API failed after ${MAX_ITEMS_RETRIES} retries: ${e.message}`, 'warning');
              break;
            }
            const retryDelay = Math.min(3000 * itemsRetries, 15000);
            log(`  ⚠ Items API error (attempt ${itemsRetries}/${MAX_ITEMS_RETRIES}): ${e.message} — retrying in ${retryDelay / 1000}s…`, 'warning');
            await delay(retryDelay);
            continue;
          }

          if (closedPicklistMessage(itemsData?.status?.statusMessage)) break;
          // Check for transient server error (statusCode 86) — retry with randomized delay
          if (itemsData?.status?.statusCode === 86) {
            itemsRetries++;
            if (itemsRetries >= MAX_ITEMS_RETRIES) {
              log(`  ⚠ Items API stuck on error 86 after ${MAX_ITEMS_RETRIES} retries`, 'warning');
              break;
            }
            // Randomized delay: base 2-5s + progressive backoff, max 15s (to avoid bot detection)
            const baseDelay = 2000 + Math.floor(Math.random() * 3000); // 2-5s random
            const retryDelay = Math.min(baseDelay + (1000 * itemsRetries), 15000);
            log(`  ⚠ Server error (code 86, attempt ${itemsRetries}/${MAX_ITEMS_RETRIES}): "${itemsData.status.statusMessage}" — retrying in ${(retryDelay / 1000).toFixed(1)}s…`, 'warning');
            await delay(retryDelay);
            continue;
          }
          break; // Got a valid (non-86) response
        }
        // If we broke out of retry loop due to max retries, break outer loop too
        if (itemsRetries >= MAX_ITEMS_RETRIES) throw new Error('Order discovery failed. Check the picklist in Myntra.');

        const status = itemsData?.status;
        if (closedPicklistMessage(status?.statusMessage)) {
          picklistClosed = true;
          log('Picklist '+picklistBarcode+' is closed. Finishing the batch.', 'info');
          break;
        }
        if (Number(status?.statusCode) === 85) break;
        if (status?.statusType === 'ERROR') throw new Error(status.statusMessage || 'Order discovery failed');

        // Extract packet info from items API response
        const packetInfo = itemsData?.data?.packetInfo;
        if (!packetInfo) {
          throw new Error('Order discovery returned no packet or closed status. Verify picklist '+picklistBarcode);
        }

        const sellerPacketId = packetInfo.id;
        const packetItemsArr = packetInfo.packetItems || [];

        if (!sellerPacketId || packetItemsArr.length === 0) {
          throw new Error('Packet or item details missing');

        }

        if (processedPacketIds.has(sellerPacketId)) {
          if (++repeatedPackets > 3) throw new Error('Myntra still returns previously processed packet '+sellerPacketId+'. Check picklist status.');
          await delay(2000);
          continue;
        }
        repeatedPackets = 0;

        // Extract refIds, portalOrderReleaseId, orderLineId from packetItems
        const approvalStarted=Date.now();
        const releaseGroups = await approvedPacketPlan(packetItemsArr,!!existingPicklistBarcode);
        for (const [release] of releaseGroups) pending.add(JSON.stringify([sellerPacketId,release]));
        await saveDraft();
        const refIds = packetItemsArr.map(item => item.refId || item.itemBarcode || String(item.id));
        const portalOrderReleaseId = packetItemsArr[0]?.portalOrderReleaseId;
        const orderLineId = packetItemsArr[0]?.orderLineId;

        log(`  📋 sellerPacketId: ${sellerPacketId}`, 'info');
        log(`  📋 refIds: [${refIds.join(', ')}]`, 'info');
        if (portalOrderReleaseId) log(`  📋 portalOrderReleaseId: ${portalOrderReleaseId}`, 'info');

        // Extract product details from styleInfo for the product card
        const styleInfo = itemsData?.data?.styleInfo;
        const styleIds = Object.keys(styleInfo || {});

        // Build items array with product details for each packet item
        const productItems = packetItemsArr.map(pItem => {
          const sid = String(pItem.styleId);
          const pDetail = styleInfo?.[sid];
          const imgEntry = pDetail?.imageCollection?.imageEntryMap?.default;
          let imgUrl = imgEntry?.resolutions?.['360X480'] || imgEntry?.path || '';
          if (imgUrl.startsWith('http://')) imgUrl = imgUrl.replace('http://', 'https://');
          const option = pDetail?.productOptions?.find(o => o.skuId === pItem.skuId) || pDetail?.productOptions?.[0];
          return {
            imageUrl: imgUrl,
            productName: pDetail?.ProductDisplayName || '',
            myntraSkuCode: option?.skuCode || `SKU-${pItem.skuId}`,
            sellerSkuCode: option?.vendorArticleNumber || sellerSkuCodeFromMapping,
            size: pItem.size || option?.value || '',
            refId: pItem.refId || pItem.itemBarcode || '',
            brand: pDetail?.brandDetails?.name || '',
          };
        });

        // For logging, use first product
        const displayMyntraSkuCode = productItems[0]?.myntraSkuCode || skuCode;
        const displaySellerSkuCode = productItems[0]?.sellerSkuCode || sellerSkuCodeFromMapping;
        const productName = productItems[0]?.productName || '';

        if (productItems.length > 1) {
          log(`  📦 Multi-item packet: ${productItems.length} items`, 'info');
          productItems.forEach((pi, i) => log(`    ${i + 1}. ${pi.productName || pi.myntraSkuCode} (${pi.size})`, 'info'));
        }

        // Show product card in the UI
        broadcast({
          type: 'SHOW_PRODUCT_CARD',
          items: productItems,
          currentSku: skuIdx + 1,
          totalSkus: skuList.length,
          orderNumber: orderCounter,
          totalItems: productItems.length,
        });

        log(`  🖼 Product: ${productName || displayMyntraSkuCode}`, 'info');
        log(`  📦 Myntra: ${displayMyntraSkuCode} | Seller: ${displaySellerSkuCode}`, 'info');

        // ── STEP 3: QC Pass ───────────────────────────────────────
        stepActive(3);
        log(`  ✅ Step 3 → QC Pass: sellerPacketId=${sellerPacketId}`, 'step');

        const qcPacketItems = refIds.map(refId => {
          const item = { refId };
          if (userLogin) item.userLogin = userLogin;
          return item;
        });

        // The allocation already checked this license for this packet. Recheck if preparation stalled.
        if(Date.now()-approvalStarted>15000)await requireLicense(!!existingPicklistBarcode);
        const qcPayload = {
          sellerPacketId: sellerPacketId,
          clientId: 'FulfilmentOrder',
          packetItems: qcPacketItems,
        };

        let qcDetails;
        let effectivePortalOrderReleaseId = portalOrderReleaseId;

        try {
          const qcResp = await apiCall(tabId, 'PUT', qcUrl, qcPayload);
          qcDetails=qcResp?.data;
          log(`  ✓ QC Pass response: ${JSON.stringify(qcResp).slice(0, 120)}`, 'success');

          // Extract portalOrderReleaseId from QC Pass response if not already found
          if (!effectivePortalOrderReleaseId) {
            const qcData = qcResp?.data;
            if (Array.isArray(qcData) && qcData.length > 0) {
              const qcPortalId = qcData[0].portalOrderReleaseId;
              if (qcPortalId) {
                effectivePortalOrderReleaseId = qcPortalId;
                log(`  ✓ portalOrderReleaseId from QC → ${qcPortalId}`, 'success');
              }
            }
          }
        } catch (e) {
          stepFailed(3);
          throw new Error(`Step 3 (QC Pass) failed for packet ${sellerPacketId}: ${e.message}`);
        }

        if (!portalOrderReleaseId && !effectivePortalOrderReleaseId && releaseGroups.has('')) {
          throw new Error('Missing order release ID after QC. Verify this packet in Myntra.');
        }
        stepDone(3);
        await delay(Math.floor(stepDelay / 2));

        // ── Cover ID resolution ────────────────────────────────────
        let coverId = defaultCoverId;
        if (askCoverIdPerOrder) {
          log(`  📷 Waiting for Cover ID scan…`, 'step');
          broadcast({
            type: 'ASK_COVER_ID',
            sellerPacketId,
            skuCode,
            orderNumber: orderCounter,
            defaultCoverId,
          });
          coverId = await waitForCoverId();
          broadcast({ type: 'HIDE_COVER_ID' });
          log(`  ✓ Cover ID: ${coverId}`, 'success');
        }

        // ── STEP 4: Mark Ready to Ship ────────────────────────────
        stepActive(4);
        log(`  📦 Step 4 → RTS: sellerPacketId=${sellerPacketId}, coverId=${coverId}`, 'step');

        const rtsUrl = `https://partnersapi.myntrainfo.com/api/mdirect/packets/${sellerPacketId}/ready-to-ship`;
        const rtsPayload = {
          sellerPacketId: sellerPacketId,
          packetBarcode: coverId,
          clientId: 'FulfilmentOrder',
          packetItems: refIds.map(refId => ({ refId })),
        };

        let shippingResponse;
        try {
          const rtsResp = await apiCall(tabId, 'PUT', rtsUrl, rtsPayload);
          shippingResponse=rtsResp?.data;
          log(`  ✓ RTS response: ${JSON.stringify(rtsResp).slice(0, 120)}`, 'success');
        } catch (e) {
          stepFailed(4);
          throw new Error(`Step 4 (Ready-to-Ship) failed for packet ${sellerPacketId}: ${e.message}`);
        }

        stepDone(4);
        await delay(Math.floor(stepDelay / 2));

        // ── STEP 5: Print Invoice & Label directly via QZ Tray ───────────
        stepActive(5);
        log(`  🖨️  Step 5 → Printing packet ${sellerPacketId}…`, 'step');
        log(`  → Invoice→"${invoicePrinter}" | Label→"${labelPrinter}"`, 'info');

        orderLoop: for (const [release, indices] of releaseGroups) {
          const sellerOrderId = release || String(effectivePortalOrderReleaseId || '').trim();
          if (!sellerOrderId) throw new Error('Order release ID missing after QC. Verify the order in Myntra.');
          if (seenOrders.has(sellerOrderId) || rows.some(row => row[1] === sellerOrderId && row[2] !== String(sellerPacketId))) throw new Error('Order '+sellerOrderId+' appeared in another packet. Verify its shipping documents in Myntra.');
          seenOrders.add(sellerOrderId);
          const displaySellerSkuCode = productItems[indices[0]].sellerSkuCode;
          const shipments=Array.isArray(shippingResponse)?shippingResponse:[shippingResponse];
          const shipment=shipments.find(v=>v && String(v.portalOrderReleaseId)===sellerOrderId)
            || (releaseGroups.size===1 && shipments.length===1 && shipments[0]?.portalOrderReleaseId==null ? shipments[0] : null);
          const currentRows=indices.map(index=>{
            const item=productItems[index], raw=packetItemsArr[index];
            const updates=[qcDetails,shipment].flatMap(value=>Array.isArray(value)?value:[value]).filter(Boolean);
            const itemUpdates=updates.flatMap(value=>[value,...(Array.isArray(value.packetItems)?value.packetItems:[]),...(Array.isArray(value.packetInfo?.packetItems)?value.packetInfo.packetItems:[])])
              .filter(v=>(v.portalOrderReleaseId==null || String(v.portalOrderReleaseId)===sellerOrderId) &&
                ((raw.orderLineId!=null && String(v.orderLineId)===String(raw.orderLineId)) || (raw.refId!=null && String(v.refId)===String(raw.refId))));
            const option=styleInfo?.[raw.styleId]?.productOptions?.find(o=>raw.skuId!=null && String(o.skuId)===String(raw.skuId));
            const fields=orderFields(raw,releaseGroups.size===1?packetInfo:null,shipment,option);
            for(const itemUpdate of itemUpdates)orderFields(itemUpdate,null,null).forEach((v,i)=>{if(fields[i]==='')fields[i]=v;});
            return [picklistBarcode,sellerOrderId,String(sellerPacketId),raw.orderLineId,refIds[index],item.sellerSkuCode,item.myntraSkuCode,item.productName,item.brand,item.size,coverId,
              'Not attempted','Not attempted','',...fields,'Pending'];
          });
          for(let i=rows.length-1;i>=0;i--) {
            if(rows[i][1]===sellerOrderId && rows[i][2]===String(sellerPacketId))rows.splice(i,1);
          }
          rows.push(...currentRows);
          const recordStatus=async(status,doc,output)=>{
            for(const row of currentRows){
              row[22]=status;
              if(doc)row[doc==='Invoice'?11:12]=output;
              if(status==='Success')row[13]=new Date().toISOString();
            }
            await saveDraft();
          };
          await saveDraft();
          // ── Check Print Single permission ────────────────────────
          if (batchPrintPermission === 'single') {
            log(`  🖨️  Waiting for print confirmation for Order ID: ${sellerOrderId}…`, 'step');

            const printConfirmArr = await chrome.scripting.executeScript({
              target: { tabId },
              func: async (orderId, sku) => {
                return new Promise((resolve) => {
                  const overlay = document.createElement('div');
                  overlay.className = 'diwan-dialog';
            overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.6);z-index:2147483647;display:flex;align-items:center;justify-content:center;';

                  const modal = document.createElement('div');
                  modal.style.cssText = 'background:#fff;border:3px solid #0F282F;border-radius:12px;padding:30px;width:400px;max-width:90%;box-shadow:8px 8px 0 #0F282F;font-family:system-ui,-apple-system,sans-serif;color:#0F282F;text-align:center;';

                  modal.innerHTML = `
                    <div style="font-size:40px;margin-bottom:15px">🖨️</div>
                    <h2 style="margin:0 0 15px 0;font-size:22px;font-weight:800;text-transform:uppercase;">Print Order?</h2>
                    <div style="background:#e0f7fa;border:2px solid #0F282F;padding:15px;border-radius:8px;margin-bottom:20px;text-align:left;">
                      <p style="margin:0 0 8px 0;font-weight:600;">Order ID: <span style="font-weight:400;"><b data-order></b></span></p>
                      <p style="margin:0;font-weight:600;">SKU: <span style="font-weight:400;"><b data-sku></b></span></p>
                    </div>
                    <div style="display:flex;gap:15px;justify-content:center;">
                      <button id="moa-print-btn" style="flex:1;background:#4CAF50;color:#0F282F;border:2px solid #0F282F;padding:12px;font-weight:700;border-radius:6px;cursor:pointer;box-shadow:4px 4px 0 #0F282F;transition:transform 0.1s;text-transform:uppercase;">Print</button>
                      <button id="moa-skip-print-btn" style="flex:1;background:#f44336;color:#fff;border:2px solid #0F282F;padding:12px;font-weight:700;border-radius:6px;cursor:pointer;box-shadow:4px 4px 0 #0F282F;transition:transform 0.1s;text-transform:uppercase;">Skip</button>
                    </div>
                  `;

                  modal.querySelector('[data-order]').textContent = orderId;
                  modal.querySelector('[data-sku]').textContent = sku;
                  overlay.appendChild(modal);
                  document.body.appendChild(overlay);

                  const printBtn = document.getElementById('moa-print-btn');
                  const skipBtn = document.getElementById('moa-skip-print-btn');

                  const addPressEffect = (btn) => {
                    btn.onmousedown = () => { btn.style.transform = 'translate(2px, 2px)'; btn.style.boxShadow = '2px 2px 0 #0F282F'; };
                    btn.onmouseup = () => { btn.style.transform = ''; btn.style.boxShadow = '4px 4px 0 #0F282F'; };
                    btn.onmouseleave = () => { btn.style.transform = ''; btn.style.boxShadow = '4px 4px 0 #0F282F'; };
                  };
                  addPressEffect(printBtn);
                  addPressEffect(skipBtn);

                  printBtn.onclick = () => { document.body.removeChild(overlay); resolve('PRINT'); };
                  skipBtn.onclick = () => { document.body.removeChild(overlay); resolve('SKIP'); };
                });
              },
              args: [sellerOrderId, displaySellerSkuCode],
            });

            if (printConfirmArr?.[0]?.result === 'SKIP') {
              await recordStatus('Skipped');
              log(`⏭ Order ${sellerOrderId} print skipped by user. Continuing...`, 'warning');


              continue;
            }
          }

          const qp = new URLSearchParams({
            sellerId: effectiveConfig.sellerId,
            campaignEnriched: 'false',
            sellerOrderId: sellerOrderId,
          });

          const invoiceUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/getPacketInvoice/${storePartnerId}?${qp}`;
          const labelUrl = `https://partnersapi.myntrainfo.com/api/mdirect/orders/getShippingLabelForSellerPacketV2/${storePartnerId}?${qp}`;

          log(`  → sellerPacketId=${sellerPacketId} → detecting QZ Tray + fetching PDFs…`, 'info');


          const docs=[
            {kind:'Invoice',url:invoiceUrl,printer:invoicePrinter,savePdf:invoiceIsPdf},
            {kind:'Label',url:labelUrl,printer:labelPrinter,savePdf:labelIsPdf}
          ];
          for(const d of docs)d.key='diwanJob:'+JSON.stringify([effectiveConfig.sellerId,picklistBarcode,sellerOrderId,d.kind]);
          const printed=await printOrderPair({speedMode,sellerId:effectiveConfig.sellerId,docs,tabId,xsrfToken,archiveFolder,sellerOrderId,sellerPacketId,currentRows,recordStatus,singleItem:indices.length===1});
          if(!printed)continue orderLoop;
          await recordStatus('Success');
          pending.delete(JSON.stringify([sellerPacketId,release]));
          await saveDraft();
          ordersProcessedForThisSku++;
          summaryData.totalOrders++;
          if (indices.length > 1) summaryData.multiItemOrders++;
          else summaryData.singleItemOrders++;

          log('Invoice and label completed for '+sellerOrderId,'success');
        } // end order release
        stepDone(5);

        processedPacketIds.add(sellerPacketId); // Mark this packet as processed
        globalOrderCounter += releaseGroups.size;

        if (!isResumeMode && globalOrderCounter >= targetQuantity) {
          log(`✅ Reached requested total quantity of ${targetQuantity} order(s). Stopping early.`, 'success');
          break;
        }

        await delay(Math.floor(stepDelay / 2));

      } // end inner while-loop (orders for this SKU)

      log(`✅ SKU ${skuCode} completed — ${ordersProcessedForThisSku} order(s) processed.`, 'success');

      // ── Track per-SKU summary ────────────────────────────────
      summaryData.skuBreakdown.push({
        skuCode: skuCode,
        sellerSkuCode: sellerSkuCodeFromMapping,
        ordersProcessed: ordersProcessedForThisSku,
      });

      if (!isResumeMode && globalOrderCounter >= targetQuantity) {
        break; // break outer loop too
      }

      if (picklistClosed) break;

      // After all orders for this SKU are exhausted, ask user to proceed to next SKU
      if (skuIdx < skuList.length - 1) {
        if (ordersProcessedForThisSku === 0) {
          log(`⏩ SKU ${skuCode} has no pending orders — auto-skipping to next.`, 'info');
          continue;
        }

        // Check pauseOnSkuChange config
        if (pauseOnSkuChange) {
          log(`⏳ Waiting for user to proceed to next SKU…`, 'info');
          broadcast({
            type: 'SHOW_NEXT_SKU_BTN',
            nextSkuCode: skuList[skuIdx + 1].myntraSkuCode,
            nextSellerSkuCode: skuList[skuIdx + 1].sellerSkuCode,
            nextSkuIdx: skuIdx + 2,
            totalSkus: skuList.length,
          });
          await waitForNextSku();
          broadcast({ type: 'HIDE_NEXT_SKU_BTN' });
          log(`▶ User confirmed — proceeding to next SKU…`, 'info');
        } else {
          log(`⏩ Auto-proceeding to next SKU (pause disabled)…`, 'info');
          await delay(stepDelay);
        }
      }
    } // end SKU loop

    broadcast({ type: 'HIDE_PRODUCT_CARD' });

    // ── Summary ──────────────────────────────────────────────
    summaryData.endTime = Date.now();
    summaryData.totalSkus = summaryData.skuBreakdown.length;
    const elapsed = Math.round((summaryData.endTime - summaryData.startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    summaryData.elapsedFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    log(`🎉 All ${skuList.length} SKU(s) processed!`, 'success');
    log(`📊 Summary: ${summaryData.totalOrders} orders | ${summaryData.totalSkus} SKUs | Single: ${summaryData.singleItemOrders} | Multi: ${summaryData.multiItemOrders} | Time: ${summaryData.elapsedFormatted}`, 'success');

    if (rows.length && pending.size === 0) {
      await chrome.storage.local.set({diwanLastBatch:{barcode:picklistBarcode,rows},diwanExportLabel:picklistBarcode});
      await chrome.storage.local.remove(draftKey);
    } else if (pending.size) log('A print was skipped. No completed workbook for this batch.', 'warning');
    // Broadcast summary to UI
    broadcast({ type: 'SHOW_SUMMARY', summary: summaryData });

    if (pending.size) throw new Error('Batch incomplete. Review skipped or unconfirmed documents for '+picklistBarcode);
    // ── Finish ────────────────────────────────────────────────
    log('─────────────────────────────────────────', 'info');
    done();

  } catch (err) {
    log(`Pipeline stopped: ${err.message}`, 'error');
    error(err.message);
  } finally {
    stopKeepAlive();
    automationState.running = false;
  }
}

// ─────────────────────────────────────────────────────────────
//  Message handler
// ─────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.action === 'EXPORT_DIWAN') {
    const url=new URL(chrome.runtime.getURL('excel.html'));
    if (typeof msg.draftKey === 'string' && msg.draftKey.startsWith('diwanDraft:')) url.searchParams.set('draft',msg.draftKey);
    chrome.tabs.create({url:url.href}).then(()=>sendResponse({ok:true}),err=>sendResponse({error:err.message}));
    return true;
  }
  if (msg.action === 'LICENSE_LOGIN' || msg.action === 'LICENSE_LOGOUT') {
    if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
    (async()=>{
      if(msg.action==='LICENSE_LOGOUT'){
        try{await licenseCall('logout');}finally{await chrome.storage.local.remove('diwanSession');}
        return {};
      }
      const result=await licenseCall('login',{key:msg.key});
      await chrome.storage.local.set({diwanSession:result.session});
      return {user:result.user};
    })().then(sendResponse,e=>sendResponse({message:e.message}));
    return true;
  }
  if(msg.action==='GET_LICENSE_STATUS'){
    requireLicense().then(user=>sendResponse({licensed:true,user}),e=>sendResponse({licensed:false,message:e.message}));
    return true;
  }

  // START_AUTOMATION – can come from popup OR content script FAB
  if (msg.action === 'START_AUTOMATION') {
    if (automationState.running) {
      error('Automation is already running.');
      sendResponse({ started: false, reason: 'already_running' });
      return true;
    }

    // If tabId not provided (called from content script FAB),
    // use the sender's tab ID
    const tabId = msg.tabId || sender?.tab?.id;
    if (!tabId) {
      error('Could not determine Myntra tab ID. Please try from the toolbar popup.');
      sendResponse({ started: false, reason: 'no_tab_id' });
      return true;
    }

    // Store the source tab so broadcast() can relay messages to it
    automationState.tabId = tabId;

    automationState.running = true;
    runAutomation({
      speedMode:msg.speedMode,
      tabId,
      delay: msg.delay || 1500,
      quantity: msg.quantity || CONFIG.quantity,
      orderType: msg.orderType || CONFIG.orderType,
      existingPicklistBarcode: msg.existingPicklistBarcode || '',
    }).catch(e => { automationState.running = false; error(e.message); });
    sendResponse({ started: true });
    return true;
  }

  // GET_CURRENT_TAB – called by content script FAB to get its own tab ID
  if (msg.action === 'GET_CURRENT_TAB') {
    const tabId = sender?.tab?.id;
    sendResponse({ tabId });
    return true;
  }

  if (msg.action === 'NEXT_SKU_CONFIRMED') {
    if (nextSkuResolver) {
      nextSkuResolver();
      nextSkuResolver = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'COVER_ID_RESPONSE') {
    if (coverIdResolver) {
      coverIdResolver(msg.coverId || 'myntra123');
      coverIdResolver = null;
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'RESET') {
    if(automationState.running){sendResponse({reset:false});return true;}
    stopKeepAlive();
    automationState.running = false;
    sendResponse({ reset: true });
    return true;
  }

  // GET_PRINTERS – Fetch available printers from QZ Tray via Myntra tab
  if (msg.action === 'GET_PRINTERS') {
    (async () => {
      try {
        await connectLocalPrinter();
        const printers=await qz.printers.find();
        sendResponse({success:true,printers:Array.isArray(printers)?printers:[printers]});
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
    return true; // async response
  }
});

