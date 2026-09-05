import { LANGS, langByCode, tonePrompt, SUB_SYSTEM, OCR_PROMPT, DOC_PROMPT, TONE_WORDS, DEFAULTS } from './config.js';
import * as state from './state.js';
import { haptic, downloadFile, hashStr, fmtBytes, maskKey, toFa, sleep } from './utils.js';
import * as gemini from './services/gemini.js';
import * as audio from './services/audio.js';
import * as docs from './services/document.js';

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const icon = name => '<svg class="ms" width="22" height="22"><use href="#i-' + name + '"/></svg>';

const worker = new Worker('./js/workers/processor.worker.js');
let wSeq = 0;
const wPending = new Map();
worker.onmessage = e => {
  const d = e.data || {};
  const p = wPending.get(d.id);
  if (!p) return;
  wPending.delete(d.id);
  if (d.ok) p.resolve(d.result); else p.reject(new Error(d.error || 'خطای ورکر'));
};
worker.onerror = () => {
  for (const p of wPending.values()) p.reject(new Error('خطای ورکر پردازش'));
  wPending.clear();
};
function callWorker(type, payload = {}){
  return new Promise((resolve, reject) => {
    const id = ++wSeq;
    wPending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
    setTimeout(() => {
      if (wPending.has(id)){ wPending.delete(id); reject(new Error('پاسخی از ورکر پردازش دریافت نشد')); }
    }, 30000);
  });
}

function toast(msg, type = 'info'){
  const box = document.createElement('div');
  box.className = 'toast ' + type;
  box.textContent = msg;
  $('#toasts').appendChild(box);
  setTimeout(() => { box.classList.add('bye'); setTimeout(() => box.remove(), 350); }, 3600);
}
state.on('toast', d => toast(d.msg, d.type || 'info'));

async function copyText(t){
  try { await navigator.clipboard.writeText(t); toast('کپی شد', 'ok'); }
  catch (e) { toast('کپی ممکن نشد', 'error'); }
}

let sheetResolve = null;
function confirmDialog(title, msg, okLabel = 'تأیید'){
  $('#sheet-title').textContent = title;
  $('#sheet-msg').textContent = msg;
  $('#sheet-ok').textContent = okLabel;
  $('#sheet').classList.remove('hidden');
  return new Promise(res => { sheetResolve = res; });
}
function closeSheet(v){
  $('#sheet').classList.add('hidden');
  if (sheetResolve){ sheetResolve(v); sheetResolve = null; }
}

function applyTheme(){
  const pref = state.get('theme');
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name="theme-color"]').setAttribute('content', dark ? '#111411' : '#2d6930');
  $$('#seg-theme button').forEach(b => b.classList.toggle('on', b.dataset.themeChoice === pref));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (state.get('theme') === 'system') applyTheme();
});

function applyFont(){
  const v = state.get('fontScale') || 1;
  document.documentElement.style.setProperty('--font-scale', v);
  $('#font-range').value = Math.round(v * 100);
  $('#font-val').textContent = toFa(Math.round(v * 100)) + '٪';
}

let activeTab = 'panel-text';
function switchTab(id){
  if (id !== activeTab && activeTab === 'panel-camera') stopCamera();
  if (id !== activeTab && activeTab === 'panel-text' && audio.isListening()) audio.stopListening();
  activeTab = id;
  $$('.panel').forEach(p => p.classList.toggle('active', p.id === id));
  $$('#bottom-nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  movePill();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function movePill(){
  const btn = $('#bottom-nav button[data-tab="' + activeTab + '"]');
  const iconEl = btn && btn.querySelector('.ms');
  const pill = $('#nav-pill');
  if (!btn || !iconEl) return;
  const nb = $('#bottom-nav').getBoundingClientRect();
  const ib = iconEl.getBoundingClientRect();
  pill.style.width = (ib.width + 30) + 'px';
  pill.style.transform = 'translateX(' + (ib.left - nb.left - 15) + 'px)';
  pill.style.opacity = '1';
}

async function ensureReady(){
  if (!state.get('keys').length){
    toast('ابتدا از تب تنظیمات حداقل یک کلید Gemini API اضافه کنید.', 'warn');
    switchTab('panel-settings');
    return false;
  }
  try { await gemini.refreshModels(); return true; }
  catch (e){ toast(e.message, 'error'); return false; }
}

function toggleBusy(p, on){
  const map = {
    text:   ['#btn-translate', '#btn-stop-text'],
    camera: ['#btn-shot', '#btn-stop-cam'],
    docs:   ['#btn-doc-translate', '#btn-doc-cancel'],
    subs:   ['#btn-sub-translate', '#btn-sub-cancel']
  };
  const [b, s] = map[p];
  $(b).disabled = on;
  $(s).classList.toggle('hidden', !on);
}

function handleStreamError(e, outEl){
  if (e && e.name === 'AbortError'){ toast('ترجمه متوقف شد.', 'info'); return; }
  toast(e.message || 'خطای ناشناخته در ترجمه', 'error');
  if (outEl) outEl.textContent = (outEl.textContent ? outEl.textContent + '\n\n' : '') + 'خطا: ' + (e.message || 'نامشخص');
}

/* ═══════════ تب ۱: متن و گفتار ═══════════ */
let textCtl = null, textBusy = false, autoSendTimer = 0;

function fillSelects(){
  const src = $('#sel-source'), tgt = $('#sel-target');
  src.innerHTML = ''; tgt.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = 'auto'; auto.textContent = 'تشخیص خودکار';
  src.appendChild(auto);
  for (const l of LANGS){
    const o1 = document.createElement('option'); o1.value = l.code; o1.textContent = l.fa; src.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = l.code; o2.textContent = l.fa; tgt.appendChild(o2);
  }
  src.value = state.get('sourceLang') || 'auto';
  tgt.value = state.get('targetLang') || 'fa';
  if (src.selectedIndex < 0) src.value = 'auto';
  if (tgt.selectedIndex < 0) tgt.value = 'fa';
  src.addEventListener('change', () => state.setSetting('sourceLang', src.value));
  tgt.addEventListener('change', () => state.setSetting('targetLang', tgt.value));
}

function initToneSeg(){
  const cur = state.get('tone') || 'fluent';
  $$('#seg-tone button').forEach(b => {
    b.classList.toggle('on', b.dataset.tone === cur);
    b.onclick = () => {
      haptic(12);
      $$('#seg-tone button').forEach(x => x.classList.toggle('on', x === b));
      state.setSetting('tone', b.dataset.tone);
    };
  });
}

async function translateText(){
  if (textBusy) return;
  const src = $('#src-input').value.trim();
  if (!src){ toast('متنی برای ترجمه وارد کنید.', 'warn'); return; }
  if (!await ensureReady()) return;
  const out = $('#out-text');
  textBusy = true;
  toggleBusy('text', true);
  out.textContent = '';
  textCtl = new AbortController();
  const tLang = langByCode(state.get('targetLang')) || LANGS[0];
  const system = tonePrompt(state.get('tone'), tLang.en);
  try {
    await gemini.streamGenerate({
      system,
      contents: [{ role: 'user', parts: [{ text: src }] }],
      signal: textCtl.signal,
      onChunk: (c, full) => { out.textContent = full; }
    });
    if (state.get('autoSpeak')) audio.speak(out.textContent, tLang.code);
  } catch (e) {
    handleStreamError(e, out);
  } finally {
    textBusy = false;
    toggleBusy('text', false);
  }
}

function asrLocale(){
  const c = state.get('sourceLang');
  const l = langByCode(c === 'auto' ? 'fa' : c);
  return l ? l.asr : 'fa-IR';
}

async function toggleMic(){
  haptic(12);
  if (audio.isListening()){ audio.stopListening(); return; }
  try {
    await audio.startListening({
      lang: asrLocale(),
      onState: live => setLive(live),
      onInterim: t => {
        $('#ghost-wrap').classList.remove('hidden');
        $('#ghost-line').textContent = t;
      },
      onFinal: t => {
        const ta = $('#src-input');
        ta.value = (ta.value ? ta.value + ' ' : '') + t;
        ta.dispatchEvent(new Event('input'));
        $('#ghost-wrap').classList.add('hidden');
        $('#ghost-line').textContent = '';
        if (state.get('autoSend')){
          clearTimeout(autoSendTimer);
          autoSendTimer = setTimeout(() => {
            if (!textBusy && $('#src-input').value.trim() && activeTab === 'panel-text') translateText();
          }, 1000);
        }
      },
      onError: err => { toast(err.message, 'error'); setLive(false); }
    });
  } catch (e) {
    toast(e.message || 'شروع شنود ناموفق بود', 'error');
    setLive(false);
  }
}

function setLive(live){
  $('#island-mic').classList.toggle('live', live);
  $('#island-status').textContent = live ? 'شنود زنده فعال…' : 'میکروفن آماده';
}

function bindText(){
  fillSelects();
  initToneSeg();
  $('#btn-swap').onclick = () => {
    const s = $('#sel-source'), t = $('#sel-target'), ta = $('#src-input'), out = $('#out-text');
    const oldS = s.value;
    s.value = t.value;
    t.value = oldS === 'auto' ? 'fa' : oldS;
    state.setSetting('sourceLang', s.value);
    state.setSetting('targetLang', t.value);
    if (oldS !== 'auto'){
      const outTxt = out.querySelector('.placeholder') ? '' : out.textContent.trim();
      if (outTxt){
        ta.value = outTxt;
        out.innerHTML = '<span class="placeholder">ترجمه اینجا ظاهر می‌شود…</span>';
        ta.dispatchEvent(new Event('input'));
      }
    }
  };
  $('#btn-translate').onclick = translateText;
  $('#btn-stop-text').onclick = () => { textCtl && textCtl.abort(); };
  $('#btn-clear').onclick = () => {
    $('#src-input').value = '';
    $('#out-text').innerHTML = '<span class="placeholder">ترجمه اینجا ظاهر می‌شود…</span>';
    $('#char-count').textContent = '۰ نویسه';
    $('#ghost-wrap').classList.add('hidden');
    $('#ghost-line').textContent = '';
  };
  $('#btn-copy').onclick = () => {
    const t = $('#out-text').textContent;
    if (!t){ toast('چیزی برای کپی نیست', 'warn'); return; }
    copyText(t);
  };
  $('#btn-speak').onclick = () => {
    if (audio.isSpeaking()){ audio.stopSpeaking(); return; }
    const t = $('#out-text').textContent;
    if (!t){ toast('متنی برای پخش نیست', 'warn'); return; }
    audio.speak(t, langByCode(state.get('targetLang')).code);
  };
  $('#src-input').addEventListener('input', e => {
    $('#char-count').textContent = toFa(e.target.value.length) + ' نویسه';
  });
  $('#src-input').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); translateText(); }
  });
  $('#island-mic').onclick = toggleMic;
}

/* ═══════════ تب ۲: دوربین و OCR ═══════════ */
let camStream = null, camCtl = null, camBusy = false, lastImgURL = null;

async function startCamera(){
  if (camStream){ stopCamera(); return; }
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const v = $('#cam-video');
    v.srcObject = camStream;
    await v.play().catch(() => {});
    $('#cam-view').classList.remove('off');
    $('#btn-cam').innerHTML = icon('videocam-off') + 'خاموش کردن دوربین';
    $('#btn-shot').disabled = false;
  } catch (e) {
    camStream = null;
    const denied = e && e.name === 'NotAllowedError';
    toast(denied
      ? 'دسترسی به دوربین رد شد. از نوار آدرس مرورگر یا تنظیمات سیستم‌عامل مجوز دوربین را فعال کنید.'
      : 'دوربین در دسترس نیست: ' + ((e && (e.message || e.name)) || 'نامشخص'), 'error');
  }
}

function stopCamera(){
  if (camStream){ camStream.getTracks().forEach(t => t.stop()); camStream = null; }
  const v = $('#cam-video');
  if (v) v.srcObject = null;
  $('#cam-view').classList.add('off');
  $('#btn-cam').innerHTML = icon('videocam') + 'روشن کردن دوربین';
  $('#btn-shot').disabled = true;
}

function compressToBase64(blob, maxW, q){
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / (img.naturalWidth || maxW));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * scale));
        c.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const cx = c.getContext('2d');
        cx.fillStyle = '#ffffff';
        cx.fillRect(0, 0, c.width, c.height);
        cx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', q).split(',')[1]);
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تصویر قابل خواندن نیست')); };
    img.src = url;
  });
}

function showPreview(blobOrFile){
  const url = URL.createObjectURL(blobOrFile);
  const img = $('#img-preview');
  img.src = url;
  img.classList.remove('hidden');
  $('#btn-img-clear').classList.remove('hidden');
  if (lastImgURL) URL.revokeObjectURL(lastImgURL);
  lastImgURL = url;
}

function clearPreview(){
  const img = $('#img-preview');
  img.classList.add('hidden');
  img.removeAttribute('src');
  $('#btn-img-clear').classList.add('hidden');
  if (lastImgURL){ URL.revokeObjectURL(lastImgURL); lastImgURL = null; }
}

async function processImage(blob){
  if (camBusy) return;
  if (!await ensureReady()) return;
  camBusy = true;
  toggleBusy('camera', true);
  camCtl = new AbortController();
  $('#ocr-status').textContent = 'در حال فشرده‌سازی و ارسال تصویر…';
  $('#ocr-raw').textContent = '—';
  $('#ocr-out').textContent = '…';
  $('#btn-ocr-copy').classList.add('hidden');
  try {
    const b64 = await compressToBase64(blob, 1280, 0.82);
    const tLang = langByCode(state.get('targetLang')) || LANGS[0];
    const system = OCR_PROMPT(tLang.en, TONE_WORDS[state.get('tone')] || TONE_WORDS.fluent);
    let full = '';
    await gemini.streamGenerate({
      system,
      contents: [{ role: 'user', parts: [
        { inline_data: { mime_type: 'image/jpeg', data: b64 } },
        { text: 'Extract and translate the text in this image.' }
      ]}],
      signal: camCtl.signal,
      onChunk: (c, f) => { full = f; $('#ocr-out').textContent = full; }
    });
    const i = full.indexOf('[TRANSLATION]');
    const j = full.indexOf('[TEXT]');
    if (j > -1 && i > -1){
      $('#ocr-raw').textContent = full.slice(j + 6, i).trim();
      $('#ocr-out').textContent = full.slice(i + 13).trim();
    } else {
      $('#ocr-raw').textContent = '—';
      $('#ocr-out').textContent = full.trim();
    }
    $('#btn-ocr-copy').classList.remove('hidden');
    $('#ocr-status').textContent = 'پردازش کامل شد.';
  } catch (e) {
    if (e && e.name === 'AbortError') $('#ocr-status').textContent = 'متوقف شد.';
    else {
      $('#ocr-status').textContent = 'پردازش ناموفق بود.';
      toast(e.message || 'خطای پردازش تصویر', 'error');
    }
  } finally {
    camBusy = false;
    toggleBusy('camera', false);
  }
}

function bindDropzone(zone, input, onFile){
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    if (f) onFile(f);
    input.value = '';
  });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag');
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

function bindCamera(){
  $('#btn-cam').onclick = () => { haptic(12); startCamera(); };
  $('#btn-shot').onclick = async () => {
    if (!camStream || camBusy) return;
    const v = $('#cam-video');
    if (!v.videoWidth || v.readyState < 2){ toast('تصویر دوربین هنوز آماده نیست', 'warn'); return; }
    const view = $('#cam-view');
    view.classList.remove('flash');
    void view.offsetWidth;
    view.classList.add('flash');
    const c = $('#cam-canvas');
    const w = Math.min(1280, v.videoWidth);
    const h = Math.round(v.videoHeight * w / v.videoWidth);
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, w, h);
    cx.drawImage(v, 0, 0, w, h);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    showPreview(blob);
    processImage(blob);
  };
  $('#btn-stop-cam').onclick = () => { camCtl && camCtl.abort(); };
  $('#btn-ocr-copy').onclick = () => {
    const t = $('#ocr-out').textContent;
    if (!t || t === '—'){ toast('چیزی برای کپی نیست', 'warn'); return; }
    copyText(t);
  };
  $('#btn-img-clear').onclick = clearPreview;
  bindDropzone($('#drop-cam'), $('#file-cam'), f => {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)){ toast('فقط تصاویر JPG، PNG یا WebP پشتیبانی می‌شوند', 'warn'); return; }
    showPreview(f);
    processImage(f);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && camStream) stopCamera();
  });
}

function bindPaste(){
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items){
      if (it.type && it.type.indexOf('image/') === 0){
        const f = it.getAsFile();
        if (f){
          e.preventDefault();
          switchTab('panel-camera');
          showPreview(f);
          processImage(f);
        }
        return;
      }
    }
  });
}

/* ═══════════ تب ۳: اسناد ═══════════ */
let docFile = null, docChunks = [], docCtl = null, docBusy = false, docResult = '';

async function pickDoc(f){
  if (docBusy){ docCtl && docCtl.abort(); docBusy = false; toggleBusy('docs', false); }
  docFile = f; docChunks = []; docResult = '';
  $('#doc-out').classList.add('hidden');
  $('#doc-out').textContent = '';
  $('#btn-doc-download').disabled = true;
  $('#btn-doc-copy').disabled = true;
  $('#btn-doc-translate').disabled = true;
  $('#pbar-doc-fill').style.width = '0%';
  $('#pbar-doc-label').textContent = 'آماده پردازش';
  const ext = (f.name.match(/\.([a-z0-9]+)$/i) || [])[1] || '';
  $('#doc-info').classList.remove('hidden');
  $('#doc-name').textContent = f.name;
  $('#doc-meta').textContent = fmtBytes(f.size) + ' • ' + (ext || '?').toUpperCase();
  $('#doc-status').textContent = 'در حال استخراج متن…';
  $('#doc-preview').classList.add('hidden');
  try {
    const r = await docs.extractFromFile(f, s => { $('#doc-status').textContent = s; });
    if (!r.text || !r.text.trim()){
      throw new Error('هیچ متنی از این فایل استخراج نشد (احتمالاً PDF اسکن‌شده بدون لایه متن است).');
    }
    const { chunks } = await callWorker('chunkText', { text: r.text, maxTokens: state.get('chunkTokens') || DEFAULTS.chunkTokens });
    docChunks = chunks;
    $('#doc-preview').textContent = r.text.slice(0, 700) + (r.text.length > 700 ? '…' : '');
    $('#doc-preview').classList.remove('hidden');
    $('#doc-status').textContent = 'استخراج انجام شد • ' + toFa(docChunks.length) + ' بخش ترجمه‌شونده';
    $('#btn-doc-translate').disabled = false;
  } catch (e) {
    docFile = null;
    $('#doc-status').textContent = '';
    toast(e.message || 'خواندن فایل ناموفق بود', 'error');
  }
}

function updateDocProgress(done, n, failed){
  const p = Math.round(done / n * 100);
  $('#pbar-doc-fill').style.width = p + '%';
  $('#pbar-doc-label').textContent = 'بخش ' + toFa(done) + ' از ' + toFa(n) + ' • ' + toFa(p) + '٪' + (failed ? ' • ' + toFa(failed) + ' خطا' : '');
}

async function translateDoc(){
  if (docBusy || !docChunks.length) return;
  if (!await ensureReady()) return;
  docBusy = true;
  toggleBusy('docs', true);
  docCtl = new AbortController();
  docResult = '';
  const out = $('#doc-out');
  out.classList.remove('hidden');
  out.textContent = '';
  const n = docChunks.length;
  let done = 0, failed = 0, cursor = 0;
  const results = new Array(n);
  const tLang = langByCode(state.get('targetLang')) || LANGS[0];
  const sys = DOC_PROMPT(tLang.en, TONE_WORDS[state.get('tone')] || TONE_WORDS.fluent);

  const runOne = async i => {
    const chunk = docChunks[i];
    let text = '';
    const ck = 'doc|' + state.get('targetLang') + '|' + state.get('tone') + '|' + hashStr(chunk);
    const cached = state.cacheGet(ck);
    if (cached){ text = cached; }
    else {
      text = await gemini.streamGenerate({
        system: sys,
        contents: [{ role: 'user', parts: [{ text: chunk }] }],
        signal: docCtl.signal
      });
      state.cacheSet(ck, text);
    }
    results[i] = text;
    done++;
    updateDocProgress(done, n, failed);
    out.textContent = results.filter(Boolean).join('\n\n');
  };

  const workerLoop = async () => {
    while (cursor < n){
      if (docCtl.signal.aborted) return;
      const i = cursor++;
      try { await runOne(i); }
      catch (e) {
        if (e && e.name === 'AbortError') return;
        failed++;
        results[i] = '[خطا در ترجمه این بخش: ' + (e.message || 'نامشخص') + ']';
        updateDocProgress(done, n, failed);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(state.get('concurrency') || 3, n) }, workerLoop));
  } finally {
    docBusy = false;
    toggleBusy('docs', false);
    if (docCtl.signal.aborted){
      $('#pbar-doc-label').textContent = 'پردازش متوقف شد';
      toast('ترجمه سند متوقف شد', 'info');
    } else {
      docResult = results.filter(Boolean).join('\n\n');
      out.textContent = docResult;
      $('#btn-doc-download').disabled = !docResult;
      $('#btn-doc-copy').disabled = !docResult;
      $('#pbar-doc-label').textContent = failed
        ? 'پایان یافت • ' + toFa(failed) + ' بخش خطا داشت'
        : 'ترجمه کامل شد';
    }
  }
}

function bindDocs(){
  bindDropzone($('#drop-doc'), $('#file-doc'), pickDoc);
  $('#btn-doc-translate').onclick = translateDoc;
  $('#btn-doc-cancel').onclick = () => { docCtl && docCtl.abort(); };
  $('#btn-doc-copy').onclick = () => {
    const t = $('#doc-out').textContent;
    if (!t){ toast('چیزی برای کپی نیست', 'warn'); return; }
    copyText(t);
  };
  $('#btn-doc-download').onclick = () => {
    if (!docResult) return;
    const base = docFile ? docFile.name.replace(/\.[^.]+$/, '') : 'document';
    downloadFile(base + '.translated.txt', docResult, 'text/plain;charset=utf-8');
    toast('فایل ترجمه دانلود شد', 'ok');
  };
}

/* ═══════════ تب ۴: زیرنویس ═══════════ */
let subCues = [], subIndex = new Map(), subRowTargets = [], subBatches = [];
let subBusy = false, subCtl = null, subFileName = 'subtitle';

function msShort(ms){
  const s = Math.floor(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

async function pickSub(f){
  if (subBusy){ subCtl && subCtl.abort(); subBusy = false; toggleBusy('subs', false); }
  subCues = []; subIndex = new Map(); subRowTargets = []; subBatches = [];
  $('#sub-rows').innerHTML = '';
  $('#btn-sub-translate').disabled = true;
  $('#btn-sub-download').disabled = true;
  $('#btn-sub-retry').classList.add('hidden');
  $('#pbar-sub-fill').style.width = '0%';
  $('#pbar-sub-label').textContent = 'آماده';
  subFileName = f.name.replace(/\.[^.]+$/, '');
  $('#sub-info').classList.remove('hidden');
  $('#sub-name').textContent = f.name;
  $('#sub-meta').textContent = fmtBytes(f.size);
  $('#sub-status').textContent = 'در حال پردازش…';
  try {
    const buf = await f.arrayBuffer();
    const text = docs.decodeSmart(buf);
    const r = await callWorker('parseSubtitles', { text, fileName: f.name });
    subCues = r.cues;
    subIndex = new Map(subCues.map((c, idx) => [c.i, idx]));
    const limit = state.get('cpsLimit') || DEFAULTS.cpsLimit;
    const badCps = subCues.filter(c => c.cps > limit).length;
    $('#sub-status').textContent = 'فرمت ' + r.format.toUpperCase() + ' • ' + toFa(r.count) + ' دیالوگ' +
      (badCps ? ' • ' + toFa(badCps) + ' دیالوگ با CPS بالا' : '');
    buildSubRows();
    $('#btn-sub-translate').disabled = false;
  } catch (e) {
    $('#sub-status').textContent = '';
    toast(e.message || 'پارس زیرنویس ناموفق بود', 'error');
  }
}

function buildSubRows(){
  const box = $('#sub-rows');
  box.innerHTML = '';
  subRowTargets = new Array(subCues.length);
  const frag = document.createDocumentFragment();
  const limit = state.get('cpsLimit') || DEFAULTS.cpsLimit;
  subCues.forEach((c, idx) => {
    const row = document.createElement('div');
    row.className = 'sub-row';
    const a = document.createElement('span');
    a.className = 'sub-idx';
    a.textContent = toFa(idx + 1);
    const t = document.createElement('span');
    t.className = 'sub-time';
    t.textContent = msShort(c.start) + ' ← ' + msShort(c.end);
    t.title = 'سرعت خوانش: ' + c.cps + ' کاراکتر بر ثانیه';
    if (c.cps > limit) t.classList.add('cps-bad');
    const src = document.createElement('div');
    src.className = 'sub-src';
    src.dir = 'auto';
    src.textContent = c.text;
    const tgt = document.createElement('div');
    tgt.className = 'sub-target';
    tgt.dir = 'auto';
    tgt.contentEditable = 'true';
    tgt.spellcheck = false;
    tgt.dataset.ci = idx;
    tgt.textContent = c.target || '';
    subRowTargets[idx] = tgt;
    row.append(a, t, src, tgt);
    frag.appendChild(row);
  });
  box.appendChild(frag);
}

function updateSubRow(idx){
  const cell = subRowTargets[idx];
  if (!cell) return;
  const cue = subCues[idx];
  cell.textContent = cue.target || '';
  cell.classList.toggle('failed', !!cue.failed);
}

async function translateSubs(onlyFailed = false){
  if (subBusy || !subCues.length) return;
  const failedIds = new Set(subCues.filter(c => !(c.target && c.target.trim())).map(c => c.i));
  if (onlyFailed && !failedIds.size){ toast('همه ردیف‌ها ترجمه شده‌اند', 'info'); return; }
  if (!await ensureReady()) return;
  subBusy = true;
  toggleBusy('subs', true);
  $('#btn-sub-retry').classList.add('hidden');
  subCtl = new AbortController();
  if (!onlyFailed){
    subCues.forEach((c, idx) => { c.failed = false; updateSubRow(idx); });
  }
  $('#pbar-sub-fill').style.width = '0%';
  let batches = subBatches;
  if (!onlyFailed || !batches.length){
    const built = await callWorker('buildBatches', {
      cues: subCues.map(c => ({ i: c.i, start: c.start, end: c.end, text: c.text, masked: c.masked, tags: c.tags })),
      size: state.get('subBatch') || DEFAULTS.subBatch,
      context: state.get('subContext') == null ? DEFAULTS.subContext : state.get('subContext')
    });
    batches = built.batches;
    subBatches = batches;
  }
  const sys = SUB_SYSTEM(langByCode(state.get('targetLang')).en, state.get('cpsLimit') || DEFAULTS.cpsLimit);
  const todo = onlyFailed ? batches.filter(b => b.cues.some(c => failedIds.has(c.i))) : batches;
  const total = todo.length;
  let done = 0;
  try {
    for (const b of todo){
      if (subCtl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const lines = [];
      b.ctx.forEach(cx => lines.push('CTX ::: ' + cx));
      b.cues.forEach(c => lines.push(c.i + ' ::: ' + c.text));
      let resp = null, lastErr = null;
      for (let att = 0; att < 2; att++){
        try {
          resp = await gemini.streamGenerate({
            system: sys,
            contents: [{ role: 'user', parts: [{ text: lines.join('\n') }] }],
            signal: subCtl.signal,
            temperature: 0.8
          });
          break;
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          lastErr = e;
          if (att === 0) await sleep(700);
        }
      }
      if (resp == null) throw lastErr || new Error('پاسخی دریافت نشد');
      const map = {};
      resp.split('\n').forEach(l => {
        const m = l.match(/^\s*(\d+)\s*:::\s*(.+)$/);
        if (m) map[+m[1]] = m[2].trim();
      });
      if (!Object.keys(map).length && b.cues.length === 1) map[b.cues[0].i] = resp.trim();
      const texts = b.cues.map(c => map[c.i] != null ? map[c.i] : '');
      const cleaned = (await callWorker('restoreTags', { texts, tagsList: b.tags })).texts;
      b.cues.forEach((c, k) => {
        const idx = subIndex.get(c.i);
        if (idx === undefined) return;
        if (onlyFailed && !failedIds.has(c.i)) return;
        const cue = subCues[idx];
        if (cleaned[k] && cleaned[k].trim()){ cue.target = cleaned[k]; cue.failed = false; }
        else cue.failed = true;
        updateSubRow(idx);
      });
      done++;
      const p = Math.round(done / total * 100);
      $('#pbar-sub-fill').style.width = p + '%';
      $('#pbar-sub-label').textContent = 'پرده ' + toFa(done) + ' از ' + toFa(total) + ' • ' + toFa(p) + '٪';
    }
    const remaining = subCues.filter(c => c.failed || !(c.target && c.target.trim())).length;
    $('#btn-sub-retry').classList.toggle('hidden', !remaining || subCtl.signal.aborted);
    if (subCtl.signal.aborted){
      $('#pbar-sub-label').textContent = 'ترجمه متوقف شد';
      toast('ترجمه زیرنویس متوقف شد', 'info');
    } else {
      $('#pbar-sub-label').textContent = remaining
        ? 'پایان یافت • ' + toFa(remaining) + ' ردیف ناقص ماند'
        : 'ترجمه کامل شد — می‌توانید در جدول ویرایش کنید';
      toast(remaining ? 'ترجمه انجام شد؛ ' + toFa(remaining) + ' ردیف ناقص ماند' : 'ترجمه زیرنویس کامل شد', remaining ? 'warn' : 'ok');
    }
    $('#btn-sub-download').disabled = false;
  } catch (e) {
    if (e && e.name === 'AbortError'){
      $('#pbar-sub-label').textContent = 'ترجمه متوقف شد';
      toast('ترجمه زیرنویس متوقف شد', 'info');
      $('#btn-sub-download').disabled = false;
    } else {
      toast(e.message || 'خطا در ترجمه زیرنویس', 'error');
      $('#pbar-sub-label').textContent = 'خطا در میانه پردازش — می‌توانید دوباره تلاش کنید';
      $('#btn-sub-download').disabled = false;
      $('#btn-sub-retry').classList.remove('hidden');
    }
  } finally {
    subBusy = false;
    toggleBusy('subs', false);
  }
}

function bindSubs(){
  bindDropzone($('#drop-sub'), $('#file-sub'), pickSub);
  $('#btn-sub-translate').onclick = () => translateSubs(false);
  $('#btn-sub-retry').onclick = () => translateSubs(true);
  $('#btn-sub-cancel').onclick = () => { subCtl && subCtl.abort(); };
  $('#sub-rows').addEventListener('input', e => {
    const ci = e.target.dataset && e.target.dataset.ci;
    if (ci !== undefined && subCues[+ci]){
      subCues[+ci].target = e.target.textContent;
      subCues[+ci].failed = false;
      e.target.classList.remove('failed');
    }
  });
  $('#btn-sub-download').onclick = async () => {
    if (!subCues.length) return;
    const { srt } = await callWorker('buildSrt', {
      cues: subCues.map(c => ({ i: c.i, start: c.start, end: c.end, target: c.target != null ? c.target : c.text, text: c.text }))
    });
    downloadFile(subFileName + '.translated.srt', srt, 'application/x-subrip;charset=utf-8');
    toast('فایل SRT دانلود شد', 'ok');
  };
}

/* ═══════════ تب ۵: تنظیمات ═══════════ */
function renderKeys(){
  const list = $('#key-list');
  list.innerHTML = '';
  const keys = state.get('keys');
  const now = Date.now();
  let act = 0, cool = 0, bad = 0;
  keys.forEach(k => {
    if (k.status === 'active') act++;
    else if (k.status === 'cooldown') cool++;
    else bad++;
  });
  $('#key-stats').textContent = keys.length
    ? toFa(act) + ' فعال • ' + toFa(cool) + ' خنک‌شونده • ' + toFa(bad) + ' نامعتبر'
    : 'هیچ کلیدی ثبت نشده';
  keys.forEach(k => {
    const row = document.createElement('div');
    row.className = 'key-row ' + k.status;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const main = document.createElement('div');
    main.className = 'kmain';
    const b = document.createElement('b');
    b.textContent = maskKey(k.key);
    const s = document.createElement('span');
    s.className = 'kstatus';
    s.textContent = k.status === 'active'
      ? 'فعال • ' + toFa(k.uses || 0) + ' استفاده'
      : k.status === 'cooldown'
        ? 'خنک‌سازی • ' + toFa(Math.max(0, Math.ceil((k.cooldownUntil - now) / 1000))) + ' ثانیه'
        : 'نامعتبر • ' + (k.error || '');
    main.append(b, s);
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.title = 'حذف کلید';
    del.innerHTML = icon('delete');
    del.onclick = async () => {
      if (await confirmDialog('حذف کلید', 'کلید ' + maskKey(k.key) + ' از استخر حذف شود؟', 'حذف')){
        state.removeKey(k.id);
        toast('کلید حذف شد', 'ok');
      }
    };
    row.append(dot, main, del);
    list.appendChild(row);
  });
}

function renderModel(){
  $('#model-name').textContent = gemini.currentModelName() || '—';
}

function refreshCacheSize(){
  $('#cache-size').textContent = 'حجم کش: ' + fmtBytes(state.cacheSize());
}

function refreshTtsInfo(){
  $('#tts-info').textContent = audio.voiceInfo();
}

async function micTest(){
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { toast('دسترسی میکروفن رد شد؛ از تنظیمات سیستم‌عامل و مرورگر اجازه دهید.', 'error'); return; }
  toast('۴ ثانیه صحبت کنید…', 'info');
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    let peak = 0;
    const t0 = performance.now();
    await new Promise(res => {
      (function loop(){
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++){ const d = (buf[i] - 128) / 128; sum += d * d; }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > peak) peak = rms;
        if (performance.now() - t0 < 4000) requestAnimationFrame(loop);
        else res();
      })();
    });
    stream.getTracks().forEach(t => t.stop());
    ac.close().catch(() => {});
    if (peak > 0.02) toast('میکروفن سالم است — سطح سیگنال: کافی', 'ok');
    else toast('سیگنال بسیار ضعیف است؛ میکروفن را بررسی یا غیربی‌صدا کنید.', 'warn');
  } catch (e) {
    stream.getTracks().forEach(t => t.stop());
    toast('آزمایش میکروفن ناموفق بود', 'error');
  }
}

function initConcurrencySeg(){
  const saved = state.get('concurrency') || 3;
  const shown = [1, 3, 5].reduce((a, b) => Math.abs(b - saved) < Math.abs(a - saved) ? b : a, 1);
  $$('#seg-conc button').forEach(b => {
    b.classList.toggle('on', +b.dataset.conc === shown);
    b.onclick = () => {
      haptic(12);
      $$('#seg-conc button').forEach(x => x.classList.toggle('on', x === b));
      state.setSetting('concurrency', +b.dataset.conc);
    };
  });
}

function bindSettings(){
  renderKeys();
  renderModel();
  refreshCacheSize();
  refreshTtsInfo();
  initConcurrencySeg();

  $('#btn-keys-add').onclick = () => {
    const n = state.addKeys($('#keys-input').value);
    if (n){ $('#keys-input').value = ''; toast(toFa(n) + ' کلید به استخر اضافه شد', 'ok'); }
    else toast('کلید معتبری یافت نشد (کلیدها معمولاً با AIza شروع می‌شوند)', 'warn');
  };
  $('#btn-models-refresh').onclick = async () => {
    const btn = $('#btn-models-refresh');
    btn.disabled = true;
    try {
      const m = await gemini.refreshModels(true);
      toast('استعلام موفق — ' + toFa(m.length) + ' مدل شناسایی شد', 'ok');
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; renderModel(); }
  };

  $$('#seg-theme button').forEach(b => {
    b.onclick = () => { haptic(12); state.setSetting('theme', b.dataset.themeChoice); };
  });
  $('#font-range').addEventListener('input', e => {
    state.setSetting('fontScale', +e.target.value / 100);
  });
  $('#sw-autosend').checked = state.get('autoSend') !== false;
  $('#sw-autosend').addEventListener('change', e => state.setSetting('autoSend', e.target.checked));
  $('#sw-autospeak').checked = !!state.get('autoSpeak');
  $('#sw-autospeak').addEventListener('change', e => state.setSetting('autoSpeak', e.target.checked));

  $('#btn-clear-cache').onclick = async () => {
    if (await confirmDialog('پاک‌سازی کش', 'همه ترجمه‌های ذخیره‌شده در حافظه محلی حذف شوند؟', 'پاک کن')){
      state.clearCache();
      refreshCacheSize();
    }
  };
  $('#btn-tts-test').onclick = () => { audio.speak('سلام! این آزمایش خروجی گفتار ترجمان است.', 'fa'); };
  $('#btn-mic-test').onclick = micTest;

  setInterval(() => {
    if (state.get('keys').some(k => k.status === 'cooldown')) renderKeys();
  }, 1000);
}

state.on('keys', renderKeys);
state.on('models', renderModel);
state.on('change', ({ key }) => {
  if (key === 'theme') applyTheme();
  if (key === 'fontScale'){ applyFont(); movePill(); }
  if (key === 'models') renderModel();
});

function boot(){
  applyTheme();
  applyFont();
  bindText();
  bindCamera();
  bindPaste();
  bindDocs();
  bindSubs();
  bindSettings();

  audio.setVisualizer($('#island-canvas'));
  audio.onVoicesChanged(refreshTtsInfo);

  $$('#bottom-nav button').forEach(b => {
    b.onclick = () => { haptic(12); switchTab(b.dataset.tab); };
  });

  document.addEventListener('click', e => {
    if (e.target.closest('button,.seg,[role="button"],label.as-label')) haptic(12);
  }, true);

  document.addEventListener('pointerdown', () => audio.unlockAudio(), { once: true, capture: true });

  $('#sheet-cancel').onclick = () => closeSheet(false);
  $('#sheet-ok').onclick = () => closeSheet(true);
  $('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(false); });

  window.addEventListener('resize', movePill);
  requestAnimationFrame(movePill);

  if ('serviceWorker' in navigator){
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
}
boot();
