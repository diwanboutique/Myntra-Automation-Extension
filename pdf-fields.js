// Coordinates keep price columns aligned and keep sender and recipient blocks separate.
async function readOrderPages(bytes) {
  const pdf=await globalThis.pdfjsLib.getDocument({data:bytes,isEvalSupported:false}).promise;
  const pages=[];
  try {
    for(let n=1;n<=pdf.numPages;n++){
      const page=await pdf.getPage(n), viewport=page.getViewport({scale:1}), rows=[];
      const content=await page.getTextContent();
      const tokens=content.items.filter(t=>t.str?.trim()).map(t=>{
        const [x,y]=viewport.convertToViewportPoint(t.transform[4],t.transform[5]);
        return {x,y,w:t.width,text:t.str.trim()};
      }).sort((a,b)=>a.y-b.y || a.x-b.x);
      for(const token of tokens){
        let row=rows[rows.length-1];
        if(!row || Math.abs(row[0].y-token.y)>2.5){row=[];rows.push(row);}
        row.push(token);
      }
      if(tokens.some(t=>/^buyer's name and address/i.test(t.text))){
        const tracking=readShippingCode(await page.getOperatorList());
        if(tracking)rows.push([{x:0,y:viewport.height,w:0,text:'AWB: '+tracking}]);
      }
      pages.push(rows.map(row=>row.sort((a,b)=>a.x-b.x)));
    }
  }finally{await pdf.destroy();}
  return pages;
}
function capturePdfFields(pages,singleItem,ids=[]) {
  const fields=Array(8).fill('');
  const join=row=>row.map(c=>c.text).join(' ').trim();
  const money=s=>/^(?:(?:Rs\.?|INR|₹)\s*)?\d[\d,]*(?:\.\d{1,2})?$/i.test(s)?Number(s.replace(/^[^\d]+/,'').replace(/,/g,'')):'';
  const heading=/^(?:ship(?:ping)? to|ship to address|buyer['’]s name and address|deliver to|delivery address|shipping address|consignee(?: name and address| details| address)?)\s*[:\-]?\s*$/i;
  const end=/^(?:if undelivered|buyer declaration|seller|sold by|ship(?:ped)? from|return|billing|bill to|tax invoice|invoice|courier|tracking|awb|order|product|item|payment|phone|mobile|GST|HSN|SKU|MRP|quantity|prepaid|COD)\b/i;
  for(const page of pages){
    const lines=page.map(join);
    dispatchInvoice(lines,fields,singleItem,ids);
    const blocks=[];
    for(let i=0;i<page.length;i++){
      const tokens=page[i], start=tokens.find(c=>heading.test(c.text));
      if(!start && !heading.test(lines[i]))continue;
      const x=(start||tokens[0]).x;
      const other=tokens.find(c=>c.x>x+15 && end.test(c.text));
      const block=[];
      for(const row of page.slice(i+1,i+13)){
        const col=row.filter(c=>c.x>=x-6 && (!other || c.x<other.x-5));
        const value=join(col);
        if(!value || end.test(value))break;
        block.push(value);
      }
      blocks.push(block);
    }
    for(const block of blocks){
      const first=block[0]||'';
      if(!fields[4] && /^[\p{L}][\p{L} .'-]{1,70}$/u.test(first) && !/\b(?:road|street|nagar|house|flat|lane)\b/i.test(first))fields[4]=first;
      const street=block.filter(line=>line!==fields[4] && !/^Name\s*:/i.test(line));
      if(!fields[5] && street.some(s=>/\b[1-9]\d{5}\b/.test(s)))fields[5]=street.join(', ');
      const states='Andhra Pradesh|Arunachal Pradesh|Assam|Bihar|Chandigarh|Chhattisgarh|Delhi|Goa|Gujarat|Haryana|Himachal Pradesh|Jharkhand|Karnataka|Kerala|Ladakh|Lakshadweep|Madhya Pradesh|Maharashtra|Manipur|Meghalaya|Mizoram|Nagaland|Odisha|Puducherry|Punjab|Rajasthan|Sikkim|Tamil Nadu|Telangana|Tripura|Uttar Pradesh|Uttarakhand|West Bengal|Jammu and Kashmir|Andaman and Nicobar Islands|Dadra and Nagar Haveli and Daman and Diu';
      for(const line of street){
        const match=line.match(new RegExp('(?:^|[,;])\\s*([A-Za-z .]+?)\\s*[,;-]\\s*('+states+')(?=\\s*[-, ]*\\d{6}\\b|\\s*$)','i'));
        if(match){fields[6] ||= match[1].trim();fields[7] ||= match[2];}
      }
    }
    for(const [i,row] of page.entries()){
      // Match labelled fields with the value on the same or following line.
      for(const [index,pattern] of [[0,'AWB(?:\\s*(?:No\\.?|Number|ID|Code))?|Tracking (?:ID|Number|No\\.?)|Air\\s*way\\s*bill(?: No\\.?)?'],[1,'MRP|Maximum Retail Price'],[2,'(?:Final )?Selling Price'],[3,'Grand Total|Order Total|Total Amount Payable|Total Payable|Amount Payable|Customer Payable Amount'],[4,'Customer Name|Consignee Name|Recipient Name'],[6,'Delivery City|Shipping City'],[7,'Delivery State|Shipping State']]){
        if(fields[index]!=='' || (!singleItem && [1,2].includes(index)))continue;
        const m=lines[i].match(new RegExp('^(?:'+pattern+')(?:\\s*\\((?:Rs\\.?|INR|₹)\\))?(?:\\s*[:#-]\\s*|\\s+|$)(.*)$','i'));
        if(!m)continue;
        const v=(m[1]||lines[i+1]||'').trim();
        if(index===0){if(/^(?=[\w-]*\d)[\w-]{5,40}$/.test(v))fields[index]=v;}
        else if(index<=3)fields[index]=money(v);
        else if(v && !end.test(v))fields[index]=v;
      }
      for(const [idx,head] of [[1,/^(?:mrp|maximum retail price)(?:\s*\((?:rs\.?|inr|₹)\))?$/i],[2,/^(?:final )?selling price(?:\s*\((?:rs\.?|inr|₹)\))?$/i]]){
        const j=row.findIndex(c=>head.test(c.text));
        if(j<0 || row.length<2 || fields[idx]!=='')continue;
        const mid=c=>c.x+c.w/2, center=mid(row[j]);
        const left=j?(center+mid(row[j-1]))/2:-Infinity,right=j+1<row.length?(center+mid(row[j+1]))/2:Infinity;
        for(const data of page.slice(i+1,i+9)){
          if(/^(?:sub\s*total|grand total|total|tax summary)\b/i.test(join(data)))break;
          if(!singleItem && !data.some(c=>ids.includes(c.text)))continue;
          const values=data.filter(c=>mid(c)>left && mid(c)<right).map(c=>money(c.text)).filter(v=>v!=='');
          if(values.length===1){fields[idx]=values[0];break;}
        }
      }
    }
    const basic=documentFields(lines,singleItem);
    basic.forEach((v,i)=>{if(fields[i]==='')fields[i]=v;});
  }
  return fields;
}

function readShippingCode(list) {
  const ops=globalThis.pdfjsLib.OPS, groups=new Map();
  for(let i=0;i<list.fnArray.length-1;i++){
    if(list.fnArray[i]!==ops.constructPath || list.fnArray[i+1]!==ops.fill)continue;
    const [path,,box]=list.argsArray[i];
    if(!box || path.length>6)continue;
    const [left,right,bottom,top]=box;
    if(right<=left || top-bottom<3*(right-left))continue;
    const key=bottom+':'+top;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push([left,right]);
  }
  const patterns='212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' '), matches=new Set();
  for(const bars of groups.values()){
    if(bars.length<13)continue;
    bars.sort((a,b)=>a[0]-b[0]);
    const runs=bars.flatMap(([a,b],i)=>i?[a-bars[i-1][1],b-a]:[b-a]);
    if((runs.length-7)%6)continue;
    const unit=(bars.at(-1)[1]-bars[0][0])/(((runs.length-7)/6)*11+13);
    const widths=runs.map(r=>Math.round(r/unit));
    if(runs.some((r,i)=>Math.abs(r/unit-widths[i])>0.25) || widths.slice(-7).join('')!==patterns[106])continue;
    const codes=[];
    for(let i=0;i<widths.length-7;i+=6)codes.push(patterns.indexOf(widths.slice(i,i+6).join('')));
    const checksum=codes.pop(),start=codes.shift();
    if(![104,105].includes(start) || codes.includes(-1) || (start+codes.reduce((n,c,i)=>n+(i+1)*c,0))%103!==checksum)continue;
    let mode=start===105?'C':'B', out='';
    for(const code of codes){
      if(mode==='C' && code<=99)out+=String(code).padStart(2,'0');
      else if(mode==='B' && code<95)out+=String.fromCharCode(code+32);
      else if(code===99)mode='C';
      else if(code===100)mode='B';
      else {out='';break;}
    }
    if(/^[A-Z]{2,8}\d{6,20}$/.test(out))matches.add(out);
  }
  return matches.size===1?[...matches][0]:'';
}

// Dispatch invoices identify item rows by SKU, then show amounts on a separate quantity row.
function dispatchInvoice(lines,fields,singleItem,ids){
  if(!lines.some(line=>/^Tax Invoice$/i.test(line)))return;
  const place=lines.find(l=>/^Place of Supply:/i.test(l))?.match(/^Place of Supply:\s*(.+?)(?:\s+Nature of Supply:|$)/i);
  const at=lines.findIndex(l=>/^Bill to\s*\/\s*Ship to:/i.test(l));
  if(at>=0){
    const block=[];
    for(const l of lines.slice(at+1)){
      if(/^(?:Bill From|Ship From|GSTIN|Invoice Number|Qty)\b/i.test(l))break;
      if(!/^Customer Type:/i.test(l))block.push(l.split(/\s+Customer Type:/i)[0]);
    }
    if(block.length>=2 && block.length<=8){
      const [name,...street]=block;
      fields[4] ||= name;fields[5] ||= street.join(' ');
      const city=street.at(-1).match(/(?:^|\b(?:road|street|lane|near|nagar|colony)\s+|,\s*)([A-Za-z][A-Za-z .'-]*?)\s*-\s*[1-9]\d{5}\b/i);
      if(city)fields[6] ||= city[1].replace(/^.*\b(?:road|street|lane|nagar|colony)\s+/i,'').trim();
      if(place)fields[7] ||= place[1].trim();
    }
  }
  const header=lines.join(' ');
  if(!/Gross\b/i.test(header) || !/Discount/i.test(header) || !/Total Amount/i.test(header))return;
  const amounts=s=>[...s.matchAll(/(?:\bRs\.?|₹|\bINR)\s*([\d,]+\.\d{2})/gi)].map(m=>Number(m[1].replace(/,/g,'')));
  let match=false;
  for(const line of lines){
    if(/,\s*Size\s*:/i.test(line)){
      const parts=line.split(/\s+-\s+/)[0].split(/[()]/).map(s=>s.trim());
      match=(singleItem && lines.filter(l=>/,\s*Size\s*:/i.test(l)).length===1) || ids.some(id=>parts.includes(id));
    }else if(/^TOTAL\s/i.test(line)){
      const values=amounts(line);if(values.length>=2)fields[3]=values.at(-1);
      match=false;
    }else if(match && /^\d+\s+(?:Rs|₹|INR)/i.test(line)){
      const qty=Number(line.split(/\s/)[0]),values=amounts(line);
      if(qty>0 && values.length>=3){
        fields[8]=Math.round(values[0]*100/qty)/100;
        fields[2]=Math.round(values.at(-1)*100/qty)/100;
      }
      match=false;
    }
  }
}
