// Identifiers use inline strings so Excel preserves long IDs and leading zeros.
async function createOrderWorkbook(batch) {
  const headers = ['Picklist','Order release ID','Packet ID','Order line ID','Item reference','Seller SKU','Myntra SKU','Product','Brand','Size','Cover ID','Invoice output','Label output','Completed (UTC)','Original tracking ID / AWB','Item MRP (INR)','Item selling price (INR)','Order payable total (INR)','Customer name','Delivery address','Delivery city','Delivery state','Print status','Invoice gross per item (INR)'];
  const xml = value => String(value ?? '').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rows = [headers, ...batch.rows.map(row=>{
    const result=Array.from({length:headers.length},(_,i)=>row[i] ?? '');
    for(let i=14;i<=21;i++) if(result[i]==='')result[i]='Unavailable';
    if(!result[22])result[22]=[row[11],row[12]].every(v=>/^(Queued: |Saved PDF$)/.test(v || ''))?'Success':'Unknown';
    return result;
  })];
  const cells = rows.map((row,i) => '<row r="'+(i+1)+'">'+row.map((v,j) =>
    (i>0 && ((j>=15 && j<=17) || j===23) && typeof v==='number') ? '<c r="'+String.fromCharCode(65+j)+(i+1)+'"><v>'+v+'</v></c>' :
    '<c r="'+String.fromCharCode(65+j)+(i+1)+'" t="inlineStr"><is><t xml:space="preserve">'+xml(v)+'</t></is></c>').join('')+'</row>').join('');
  const sheetNS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const relNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const pkgNS = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const zip = new JSZip();
  zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  const relationship = (type,target) => '<Relationships xmlns="'+pkgNS+'"><Relationship Id="rId1" Type="'+relNS+'/'+type+'" Target="'+target+'"/></Relationships>';
  zip.file('_rels/.rels',relationship('officeDocument','xl/workbook.xml'));
  zip.file('xl/workbook.xml','<workbook xmlns="'+sheetNS+'" xmlns:r="'+relNS+'"><sheets><sheet name="Printed orders" sheetId="1" r:id="rId1"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels',relationship('worksheet','worksheets/sheet1.xml'));
  zip.file('xl/worksheets/sheet1.xml','<worksheet xmlns="'+sheetNS+'"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="24" width="24" customWidth="1"/></cols><sheetData>'+cells+'</sheetData><autoFilter ref="A1:X'+rows.length+'"/></worksheet>');
  return zip.generateAsync({type:'blob',compression:'DEFLATE',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

async function waitForSavedPdf(id) {
  while (true) {
    const [file] = await chrome.downloads.search({id});
    if (file?.state === 'complete') return;
    if (!file || file.state === 'interrupted') throw new Error('PDF download interrupted. Check Chrome Downloads.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
