/* ═══════════ ترجمان — سرویس Gemini: چرخش کلید 429، تنزل مدل 404، استریم SSE ═══════════ */
import { get, setRuntime, nextKey, coolKey, failKey } from '../state.js';
import { sleep } from '../utils.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const BAD_MODEL = /embedding|aqa|imagen|veo|gemma|tts|native-audio|audio|image-generation|learnlm|robotics/i;

/* اولویت‌بندی: نسخه ۳ به بالا ← ۲.۵ ← ۲ ← ۱.۵ و در هر نسخه، فلش‌های سبک‌تر */
function rankModels(names){
  const uniq = [...new Set(names)];
  const tier = n => {
    const m = /gemini-(\d+)(?:\.(\d+))?/i.exec(n);
    if (!m) return 9;
    const a = +m[1], b = m[2] === undefined ? -1 : +m[2];
    if (a >= 3) return 0;
    if (a === 2 && b === 5) return 1;
    if (a === 2) return 2;
    if (a === 1 && b === 5) return 3;
    return 4;
  };
  const weight = n => /flash/i.test(n) ? (/lite/i.test(n) ? 1 : 0) : 2;
  return uniq.sort((x, y) => tier(x) - tier(y) || weight(x) - weight(y) || y.length - x.length);
}

export function currentModelName(){
  const m = get('models');
  if (!m.length) return null;
  return m[get('modelCursor') % m.length];
}

export async function refreshModels(force = false){
  const have = get('models');
  if (have.length && !force) return have;
  const total = get('keys').length;
  if (!total) throw new Error('هیچ کلید API ثبت نشده است.');
  const tried = new Set();
  for (let i = 0; i < total; i++){
    const entry = nextKey();
    if (!entry || tried.has(entry.id)) continue;
    tried.add(entry.id);
    try {
      const res = await fetch(API_BASE + '?pageSize=200', { headers: { 'x-goog-api-key': entry.key } });
      if (res.status === 429){ coolKey(entry.id); continue; }
      if (res.status === 400 || res.status === 403){ failKey(entry.id, 'HTTP ' + res.status); continue; }
      if (!res.ok) continue;
      const data = await res.json();
      const names = (data.models || [])
        .filter(m => Array.isArray(m.supportedGenerationMethods) &&
                     m.supportedGenerationMethods.includes('generateContent') &&
                     /^models\/gemini/i.test(m.name) && !BAD_MODEL.test(m.name))
        .map(m => m.name.replace(/^models\//, ''));
      const ranked = rankModels(names);
      if (ranked.length){
        setRuntime('models', ranked);
        setRuntime('modelCursor', 0);
        return ranked;
      }
    } catch (e) { /* خطای شبکه → کلید بعدی */ }
  }
  throw new Error('استعلام مدل‌ها ناموفق بود؛ اعتبار کلید یا اتصال اینترنت را بررسی کنید.');
}

function advanceModel(){
  const m = get('models');
  if (!m.length) return;
  setRuntime('modelCursor', (get('modelCursor') + 1) % m.length);
}

function extractErrMsg(t){
  try {
    const j = JSON.parse(t);
    return (j.error && j.error.message) || ('خطای سرور: ' + String(t).slice(0, 80));
  } catch (e) {
    return (t || '').slice(0, 120) || 'پاسخ نامشخص';
  }
}

/* هسته استریم: خودکار 429→کلید بعدی، 404→مدل بعدی، 401/403→کلید نامعتبر */
export async function streamGenerate({ system, contents, onChunk = null, signal = null, temperature = 0.7 } = {}){
  if (!get('models').length) await refreshModels();
  const totalKeys = Math.max(1, get('keys').length);
  const maxAttempts = totalKeys * 2 + 4;
  let lastErr = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++){
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const entry = nextKey();
    if (!entry) throw new Error('همه کلیدها در حال خنک‌سازی یا نامعتبرند؛ کمی بعد دوباره تلاش کنید.');
    const models = get('models');
    const model = models[get('modelCursor') % models.length];
    let res;
    try {
      res = await fetch(API_BASE + encodeURIComponent(model) + ':streamGenerateContent?alt=sse', {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': entry.key },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: { temperature }
        })
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e;
      await sleep(350);
      continue;
    }

    if (res.status === 429){ coolKey(entry.id); lastErr = new Error('محدودیت نرخ (429) — انتقال به کلید بعدی'); continue; }
    if (res.status === 404){ advanceModel(); lastErr = new Error('مدل یافت نشد (404) — تنزل به مدل پیشین'); continue; }
    if (res.status === 400){
      const t = await res.text().catch(() => '');
      if (/not found|not supported|unsupported|invalid model/i.test(t)){
        advanceModel();
        lastErr = new Error('مدل پشتیبانی نشد — تنزل به مدل پیشین');
        continue;
      }
      throw new Error('درخواست نامعتبر (400): ' + extractErrMsg(t));
    }
    if (res.status === 401 || res.status === 403){
      failKey(entry.id, 'HTTP ' + res.status);
      lastErr = new Error('کلید نامعتبر بود — انتقال به کلید بعدی');
      continue;
    }
    if (!res.ok){
      const t = await res.text().catch(() => '');
      lastErr = new Error('HTTP ' + res.status + ': ' + extractErrMsg(t));
      await sleep(500);
      continue;
    }

    try {
      return await consumeStream(res, onChunk);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      lastErr = e;
      await sleep(300);
      continue;
    }
  }
  throw lastErr || new Error('ترجمه پس از چند تلاش ناموفق بود.');
}

async function consumeStream(res, onChunk){
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', full = '';
  while (true){
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      if (obj.error) throw new Error(extractErrMsg(JSON.stringify(obj)));
      if (obj.promptFeedback && obj.promptFeedback.blockReason){
        throw new Error('محتوا توسط فیلتر ایمنی مدل مسدود شد (' + obj.promptFeedback.blockReason + ').');
      }
      const cand = obj.candidates && obj.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      for (const p of parts){
        if (typeof p.text === 'string' && p.text){
          full += p.text;
          if (onChunk){ try { onChunk(p.text, full); } catch (e) { console.error(e); } }
        }
      }
    }
  }
  if (!full.trim()) throw new Error('مدل پاسخی برنگرداند (احتمال فعال‌بودن فیلتر ایمنی).');
  return full;
}
