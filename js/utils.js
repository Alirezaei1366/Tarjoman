/* ═══════════ ترجمان — ابزارهای کمکی مشترک ═══════════ */

export function haptic(ms = 12){
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
}

export function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

export function toFa(n){ return String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]); }

export function fmtBytes(n){
  n = +n || 0;
  if (n < 1024) return toFa(n) + ' بایت';
  const kb = n / 1024;
  if (kb < 1024) return toFa(kb.toFixed(1)) + ' کیلوبایت';
  return toFa((kb / 1024).toFixed(2)) + ' مگابایت';
}

export function maskKey(k){
  k = String(k || '');
  if (k.length <= 10) return k.slice(0, 3) + '…';
  return k.slice(0, 7) + '…' + k.slice(-4);
}

export function hashStr(s){
  let h = 5381;
  for (let i = 0; i < s.length; i++){ h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

/* دانلود امن با آزادسازی قطعی بلاب */
export function downloadFile(name, text, mime = 'text/plain;charset=utf-8'){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
