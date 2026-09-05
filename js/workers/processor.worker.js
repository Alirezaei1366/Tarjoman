self.onmessage = (e) => {
  const d = e.data || {};
  try {
    const result = route(d.type, d.payload || {});
    self.postMessage({ id: d.id, ok: true, result });
  } catch (err) {
    self.postMessage({ id: d.id, ok: false, error: (err && err.message) || String(err) });
  }
};

function route(type, p){
  switch (type){
    case 'parseSubtitles': return parseSubtitles(p.text, p.fileName);
    case 'chunkText':      return { chunks: chunkText(p.text, p.maxTokens || 1500) };
    case 'buildBatches':   return { batches: buildBatches(p.cues || [], p.size || 13, p.context == null ? 3 : p.context) };
    case 'restoreTags':    return { texts: restoreTags(p.texts || [], p.tagsList || []) };
    case 'buildSrt':       return { srt: buildSrt(p.cues || []) };
    default: throw new Error('کار ناشناخته برای ورکر: ' + type);
  }
}

function toMs(h, m, s, ms){
  return ((+h) * 3600 + (+m) * 60 + (+s)) * 1000 + parseInt(String(ms).padEnd(3, '0').slice(0, 3), 10);
}
function msToSrt(ms){
  ms = Math.max(0, Math.round(ms));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m2 = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s2 = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const x = String(ms % 1000).padStart(3, '0');
  return h + ':' + m2 + ':' + s2 + ',' + x;
}
function assTime(s){
  const m = String(s).trim().match(/(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,2})/);
  if (!m) return 0;
  return ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3])) * 1000 + (+m[4]) * 10;
}

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function parseSubtitles(text, fileName){
  const name = String(fileName || '').toLowerCase();
  const ext = (name.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const src = String(text || '').replace(/\r/g, '');
  const looksAss = /\[events\]/i.test(src) && /^\s*dialogue:/im.test(src);
  const looksMicro = /^\s*\{\d+\}\s*\{\d+\}/m.test(src);
  const looksVtt = /^\s*WEBVTT/i.test(src);

  let cues = [], format = ext || 'srt';
  if (ext === 'ass' || ext === 'ssa'){ cues = parseAss(src); format = 'ass'; }
  else if (ext === 'sub'){ cues = parseMicro(src); format = 'sub'; }
  else if (ext === 'vtt' || (!ext && looksVtt)){ cues = parseSrtLike(src); format = ext || 'vtt'; }
  else { cues = parseSrtLike(src); format = ext || 'srt'; }

  if (!cues.length && looksAss){ cues = parseAss(src); format = 'ass'; }
  if (!cues.length && looksMicro){ cues = parseMicro(src); format = 'sub'; }
  if (!cues.length){
    throw new Error('تایم‌کد معتبری (مثل 00:00:01,000 --> 00:00:03,000) در فایل یافت نشد؛ ساختار زیرنویس را بررسی کنید.');
  }

  let i = 0;
  cues = cues
    .filter(c => c.text && String(c.text).trim())
    .map(c => {
      const m = maskText(c.text);
      const dur = Math.max(0.5, (c.end - c.start) / 1000);
      return {
        i: ++i, start: c.start, end: c.end, text: c.text,
        masked: m.masked, tags: m.tags,
        dur: Math.round(dur * 10) / 10,
        cps: Math.round(c.text.replace(/\s+/g, '').length / dur * 10) / 10
      };
    });
  if (!cues.length) throw new Error('هیچ ردیف متنی معتبری در زیرنویس یافت نشد.');
  return { format, count: cues.length, cues };
}

function parseSrtLike(src){
  const cues = [];
  for (const b of src.split(/\n{2,}/)){
    const lines = b.split('\n').map(l => l.trim()).filter(l => l !== '');
    if (!lines.length) continue;
    if (/^(WEBVTT|NOTE\b|STYLE\b|REGION\b)/i.test(lines[0])) lines.shift();
    const ti = lines.findIndex(l => TIME_RE.test(l));
    if (ti < 0) continue;
    const m = lines[ti].match(TIME_RE);
    const text = lines.slice(ti + 1).join('\n').trim();
    if (!text) continue;
    cues.push({ start: toMs(m[1], m[2], m[3], m[4]), end: toMs(m[5], m[6], m[7], m[8]), text });
  }
  return cues;
}

function parseAss(src){
  const cues = [];
  let inEvents = false;
  for (const raw of src.split('\n')){
    const line = raw.trim();
    if (/^\[events\]/i.test(line)){ inEvents = true; continue; }
    if (/^\[/.test(line)){ inEvents = false; continue; }
    if (!inEvents) continue;
    const m = line.match(/^dialogue:\s*(.*)$/i);
    if (!m) continue;
    const parts = m[1].split(',');
    if (parts.length < 10) continue;
    const text = parts.slice(9).join(',').trim();
    if (!text) continue;
    cues.push({ start: assTime(parts[1]), end: assTime(parts[2]), text });
  }
  return cues;
}

function parseMicro(src){
  const fps = 25, cues = [];
  for (const line of src.split('\n')){
    const m = line.match(/^\s*\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!m) continue;
    const text = m[3].replace(/\|/g, '\n').trim();
    if (!text) continue;
    cues.push({ start: Math.round((+m[1]) / fps * 1000), end: Math.round((+m[2]) / fps * 1000), text });
  }
  return cues;
}

const RE_ASS_TAG = /\{[^}]*\}/g;
const RE_HTML_TAG = /<\/?[a-zA-Z][^>]*>/g;
const RE_ASS_BR = /\\[Nn]/g;

function maskText(text){
  const tags = [];
  const mk = (m) => '§§TAG_' + (tags.push(m) - 1) + '§§';
  const masked = String(text)
    .replace(RE_ASS_TAG, mk)
    .replace(RE_HTML_TAG, mk)
    .replace(RE_ASS_BR, mk)
    .replace(/\n/g, mk);
  return { masked, tags };
}

function restoreTags(texts, tagsList){
  return texts.map((t, ti) => {
    const tags = tagsList[ti] || [];
    const seen = new Set();
    let out = String(t == null ? '' : t).replace(/§§TAG_(\d+)§§/g, (m, num) => {
      const n = +num;
      if (n < tags.length){ seen.add(n); return tags[n]; }
      return '';
    });
    out = out.replace(/§§TAG_\d+§§/g, '');
    const missing = [];
    for (let i = 0; i < tags.length; i++) if (!seen.has(i)) missing.push(tags[i]);
    if (missing.length) out += missing.join('');
    return out.trim();
  });
}

function buildBatches(cues, size, context){
  const batches = [];
  for (let s = 0; s < cues.length; s += size){
    const slice = cues.slice(s, s + size);
    const ctx = cues.slice(Math.max(0, s - context), s)
      .map(c => String(c.text || '').replace(/\s+/g, ' ').trim());
    batches.push({
      ids: slice.map(c => c.i),
      ctx,
      cues: slice.map(c => ({ i: c.i, text: c.masked != null ? c.masked : c.text })),
      tags: slice.map(c => c.tags || [])
    });
  }
  return batches;
}

function chunkText(text, maxTokens){
  const words = s => (String(s).trim().match(/\S+/g) || []).length;
  const paras = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur.trim()){ chunks.push(cur.trim()); cur = ''; } };
  for (let para of paras){
    para = para.trim();
    if (!para) continue;
    if (words(para) > maxTokens){
      const sents = para.match(/[^.!؟?\n]+[.!؟?\n]*/g) || [para];
      let sub = '';
      for (let sn of sents){
        sn = sn.trim();
        if (!sn) continue;
        if (words(sub) + words(sn) > maxTokens && sub){ chunks.push(sub); sub = sn; }
        else sub = sub ? sub + ' ' + sn : sn;
      }
      if (sub){
        if (words(cur) + words(sub) > maxTokens && cur) flush();
        cur = cur ? cur + '\n\n' + sub : sub;
      }
      continue;
    }
    if (words(cur) + words(para) > maxTokens && cur) flush();
    cur = cur ? cur + '\n\n' + para : para;
  }
  flush();
  return chunks;
}

function buildSrt(cues){
  return cues.map((c, i) =>
    (i + 1) + '\n' + msToSrt(c.start) + ' --> ' + msToSrt(c.end) + '\n' +
    ((c.target != null && String(c.target).trim()) ? c.target : (c.text || '')) + '\n'
  ).join('\n');
}
