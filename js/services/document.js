/* ═══════════ ترجمان — استخراج متن سند در کلاینت: TXT/PDF/DOCX ═══════════ */

const CDN_PDF = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const CDN_PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const CDN_MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

const TEXT_EXT = ['txt', 'md', 'csv', 'log', 'srt', 'vtt', 'ass', 'ssa', 'sub'];

function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('بارگذاری کتابخانه از CDN ناموفق بود: ' + src));
    document.head.appendChild(s);
  });
}

/* رمزگشایی هوشمند: UTF-8 → Windows-1256 → UTF-8 غیرسخت‌گیر */
export function decodeSmart(buffer){
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch (e) {}
  try { return new TextDecoder('windows-1256').decode(buffer); } catch (e) {}
  try { return new TextDecoder('utf-8').decode(buffer); } catch (e) { return ''; }
}

export async function extractFromFile(file, onStatus){
  const status = onStatus || (() => {});
  const name = String(file.name || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';

  if (TEXT_EXT.includes(ext)){
    status('رمزگشایی متن…');
    const buf = await file.arrayBuffer();
    return { text: decodeSmart(buf), ext };
  }

  if (ext === 'pdf'){
    status('بارگذاری موتور PDF.js…');
    if (!window.pdfjsLib) await loadScript(CDN_PDF);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_PDF_WORKER;
    const data = await file.arrayBuffer();
    const doc = await window.pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++){
      status('استخراج صفحه ' + p + ' از ' + doc.numPages + '…');
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      pages.push(tcToText(tc));
    }
    return { text: pages.join('\n\n'), ext, pages: doc.numPages };
  }

  if (ext === 'docx'){
    status('بارگذاری موتور Mammoth…');
    if (!window.mammoth) await loadScript(CDN_MAMMOTH);
    const buf = await file.arrayBuffer();
    const r = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return { text: String(r.value || ''), ext };
  }

  throw new Error('فرمت «.' + ext + '» پشتیبانی نمی‌شود. از PDF، DOCX، TXT، MD یا CSV استفاده کنید.');
}

/* بازسازی خطوط و پاراگراف‌ها از آیتم‌های PDF بر اساس مختصات */
function tcToText(tc){
  const items = tc.items || [];
  const lines = [];
  let cur = null;
  for (const it of items){
    const x = it.transform[4], y = it.transform[5];
    if (cur && Math.abs(y - cur.y) < 2.5){
      cur.parts.push({ x, str: it.str });
      cur.h = Math.max(cur.h, it.height || 0);
    } else {
      if (cur) lines.push(cur);
      cur = { y, h: it.height || 10, parts: [{ x, str: it.str }] };
    }
  }
  if (cur) lines.push(cur);

  let out = '', prevY = null, prevH = 0;
  for (const ln of lines){
    ln.parts.sort((a, b) => a.x - b.x);
    const s = ln.parts.map(p => p.str).join(' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;
    const gap = prevY === null ? 0 : prevY - ln.y;
    if (prevY !== null && gap > prevH * 1.45) out += '\n\n';
    else if (out) out += '\n';
    out += s;
    prevY = ln.y;
    prevH = ln.h || prevH;
  }
  return out.trim();
}
