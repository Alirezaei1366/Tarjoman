/* ═══════════ ترجمان — لایه صوتی: قفل‌گشایی، شنود پیوسته، واچ‌داگ، بوم FFT، TTS ═══════════ */
import { emit } from '../state.js';

let audioCtx = null, micStream = null, analyser = null, freqData = null, timeData = null;
let rafId = 0, vizCanvas = null, vizCtx = null;
let recognition = null, wantListen = false, lastOpts = null;
let restartCount = 0, lastVoiceAt = 0, noSignalNotified = false;
let speaking = false, speakSession = 0;

/* ── قفل‌گشایی AudioContext با بافر صامت (دور زدن سیاست Autoplay موبایل) ── */
export function unlockAudio(){
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const buf = audioCtx.createBuffer(1, 1, 22050);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(audioCtx.destination);
    src.start(0);
  } catch (e) { /* غیربحرانی */ }
}

/* ── صداها (TTS) ── */
let voices = [], voicesCb = null;
function refreshVoices(){
  if (!('speechSynthesis' in window)) return;
  voices = window.speechSynthesis.getVoices() || [];
  if (voicesCb) voicesCb();
}
if ('speechSynthesis' in window){
  refreshVoices();
  window.speechSynthesis.onvoiceschanged = refreshVoices;
}
export function onVoicesChanged(cb){ voicesCb = cb; }

export function voiceInfo(){
  const fa = voices.filter(v => /^fa/i.test(v.lang)).length;
  if (!voices.length) return 'هیچ بسته صوتی در دسترس نیست';
  return fa ? toFaSafe(fa) + ' صدای فارسی از ' + toFaSafe(voices.length) + ' صدا'
            : 'صدای فارسی یافت نشد (' + toFaSafe(voices.length) + ' صدای دیگر موجود)';
}
function toFaSafe(n){ return String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]); }

function pickVoice(lang){
  const base = String(lang || '').split('-')[0].toLowerCase();
  return voices.find(v => v.lang.toLowerCase().replace('_', '-') === String(lang).toLowerCase()) ||
         voices.find(v => v.lang.toLowerCase().startsWith(base)) || null;
}

function chunkSpeech(t){
  const parts = t.match(/[^.!؟?;؛\n]+[.!؟?;؛]*/g) || [t];
  const out = []; let cur = '';
  for (let p of parts){
    p = p.trim(); if (!p) continue;
    if ((cur + ' ' + p).trim().length > 180 && cur){ out.push(cur); cur = p; }
    else cur = (cur ? cur + ' ' : '') + p;
  }
  if (cur) out.push(cur);
  return out.length ? out : [t];
}

export function isSpeaking(){ return speaking; }

export function speak(text, lang = 'fa'){
  if (!('speechSynthesis' in window)){
    emit('toast', { msg: 'مرورگر شما از سنتز گفتار (TTS) پشتیبانی نمی‌کند.', type: 'error' });
    return false;
  }
  const clean = String(text || '').trim();
  if (!clean) return false;
  const session = ++speakSession;
  window.speechSynthesis.cancel();
  const voice = pickVoice(lang);
  if (!voice){
    speaking = false; drawState();
    emit('toast', { msg: 'بسته صوتی زبان مقصد روی این دستگاه نصب نیست؛ ترجمه به‌صورت نوشتاری در دسترس است.', type: 'warn' });
    return false;
  }
  const chunks = chunkSpeech(clean);
  speaking = true; drawState();
  let i = 0;
  const next = () => {
    if (session !== speakSession) return;
    if (i >= chunks.length){ speaking = false; drawState(); return; }
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    u.voice = voice; u.lang = voice.lang; u.rate = 1; u.pitch = 1;
    u.onend = next;
    u.onerror = () => {
      if (session !== speakSession) return;
      speaking = false; drawState();
      emit('toast', { msg: 'پخش گفتار با خطا متوقف شد.', type: 'error' });
    };
    window.speechSynthesis.speak(u);
  };
  /* تأخیر کوتاه پس از cancel برای دور زدن باگ نژاد شناخته‌شده Chrome */
  setTimeout(next, 60);
  return true;
}

export function stopSpeaking(){
  speakSession++;
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  speaking = false; drawState();
}

/* ── بوم امواج FFT ── */
export function setVisualizer(canvas){
  vizCanvas = canvas;
  vizCtx = canvas ? canvas.getContext('2d') : null;
  drawState();
}

function drawState(){
  cancelAnimationFrame(rafId);
  if (vizCtx && (wantListen || speaking)) rafId = requestAnimationFrame(drawFrame);
  else drawIdle();
}

function drawFrame(){
  rafId = requestAnimationFrame(drawFrame);
  if (!vizCtx) return;
  const w = vizCanvas.width, h = vizCanvas.height;
  vizCtx.clearRect(0, 0, w, h);
  if (analyser && wantListen){
    analyser.getByteFrequencyData(freqData);
    analyser.getByteTimeDomainData(timeData);
    /* واچ‌داگ سطح سیگنال: اگر ۵ ثانیه صدایی نرسد، راهنمای رفع مشکل صادر شود */
    let sum = 0;
    for (let i = 0; i < timeData.length; i++){ const d = (timeData[i] - 128) / 128; sum += d * d; }
    const rms = Math.sqrt(sum / timeData.length);
    const now = performance.now();
    if (rms > 0.02){ lastVoiceAt = now; noSignalNotified = false; }
    else if (!noSignalNotified && now - lastVoiceAt > 5000 && lastOpts){
      noSignalNotified = true;
      if (lastOpts.onError) lastOpts.onError({
        code: 'no-signal',
        message: 'از میکروفن صدایی دریافت نمی‌شود. اتصال میکروفن، انتخاب دستگاه ورودی در سیستم‌عامل و رفع بی‌صدایی (Mute) را بررسی کنید.'
      });
    }
    const bars = 26, step = Math.max(1, Math.floor(freqData.length / bars)), bw = w / bars;
    vizCtx.fillStyle = '#8fd684';
    for (let i = 0; i < bars; i++){
      const v = freqData[i * step] / 255;
      const bh = Math.max(2, v * h * 0.92);
      vizCtx.fillRect(i * bw + bw * 0.2, (h - bh) / 2, bw * 0.6, bh);
    }
  } else if (speaking){
    const t = performance.now() / 180;
    vizCtx.beginPath();
    for (let x = 0; x <= w; x += 4){
      const y = h / 2 + Math.sin(x * 0.09 + t) * (h * 0.28) * Math.sin(t * 0.7 + x * 0.02);
      if (x === 0) vizCtx.moveTo(x, y); else vizCtx.lineTo(x, y);
    }
    vizCtx.strokeStyle = '#8fd684';
    vizCtx.lineWidth = 3;
    vizCtx.stroke();
  } else {
    vizCtx.fillStyle = '#5b6b58';
    vizCtx.fillRect(0, h / 2 - 1, w, 2);
  }
}

function drawIdle(){
  if (!vizCtx) return;
  const w = vizCanvas.width, h = vizCanvas.height;
  vizCtx.clearRect(0, 0, w, h);
  vizCtx.fillStyle = '#5b6b58';
  vizCtx.fillRect(0, h / 2 - 1, w, 2);
}

/* ── شنود پیوسته ── */
export function isListening(){ return wantListen; }

export async function startListening(opts){
  if (wantListen) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR){
    if (opts && opts.onError) opts.onError({ code: 'unsupported', message: 'مرورگر شما از شنود گفتار پیوسته پشتیبانی نمی‌کند. از Chrome یا Edge استفاده کنید.' });
    return;
  }
  lastOpts = opts;
  wantListen = true;
  restartCount = 0;
  noSignalNotified = false;
  lastVoiceAt = performance.now();
  if (opts && opts.onState) opts.onState(true);
  unlockAudio();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
    const srcNode = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.78;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    srcNode.connect(analyser);
    const track = micStream.getAudioTracks()[0];
    if (track) track.addEventListener('ended', () => { recoverMic(); });
  } catch (e) {
    cleanupAudioGraph();
    wantListen = false;
    if (opts && opts.onState) opts.onState(false);
    const denied = e && (/NotAllowed|Permission/.test(e.name || '') || e.name === 'SecurityError');
    if (opts && opts.onError) opts.onError({
      code: denied ? 'denied' : 'error',
      message: denied
        ? 'دسترسی به میکروفن رد شد. از نوار آدرس مرورگر یا تنظیمات سیستم‌عامل، اجازه دسترسی میکروفن را فعال کنید.'
        : 'میکروفن در دسترس نیست: ' + (e.message || e.name)
    });
    return;
  }
  startRecognizer();
  drawState();
}

function startRecognizer(){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !lastOpts) return;
  recognition = new SR();
  recognition.lang = lastOpts.lang || 'fa-IR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onresult = e => {
    if (!lastOpts) return;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++){
      const r = e.results[i];
      if (r.isFinal){
        const txt = r[0].transcript.trim();
        if (txt){ lastVoiceAt = performance.now(); if (lastOpts.onFinal) lastOpts.onFinal(txt); }
      } else interim += r[0].transcript;
    }
    if (interim && lastOpts.onInterim) lastOpts.onInterim(interim.trim());
  };
  recognition.onerror = e => {
    const err = e && e.error;
    if (err === 'not-allowed' || err === 'service-not-allowed'){
      hardStop();
      if (lastOpts && lastOpts.onError) lastOpts.onError({ code: 'denied', message: 'دسترسی میکروفن در سطح سیستم‌عامل رد شد؛ پس از اعطای مجوز دوباره تلاش کنید.' });
    } else if (err === 'network'){
      if (lastOpts && lastOpts.onError) lastOpts.onError({ code: 'network', message: 'سرویس شنود گفتار به شبکه دسترسی ندارد؛ اتصال اینترنت را بررسی کنید.' });
    }
    /* no-speech و aborted توسط واچ‌داگ و راه‌اندازی خودکار مدیریت می‌شوند */
  };
  recognition.onend = () => {
    if (wantListen && restartCount < 200){
      restartCount++;
      setTimeout(() => { if (wantListen){ try { recognition && recognition.start(); } catch (e) {} } }, 250);
    } else if (wantListen){
      hardStop();
      if (lastOpts && lastOpts.onState) lastOpts.onState(false);
      if (lastOpts && lastOpts.onError) lastOpts.onError({ code: 'failed', message: 'شنود گفتار به‌صورت مکرر قطع شد.' });
    }
  };
  try { recognition.start(); } catch (e) {}
}

/* روتین خودترمیمی: قطع ناگهانی جریان صوتی → اتصال مجدد تحلیل‌گر */
async function recoverMic(){
  if (!wantListen) return;
  cleanupAudioGraph();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const srcNode = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    freqData = new Uint8Array(analyser.frequencyBinCount);
    timeData = new Uint8Array(analyser.fftSize);
    srcNode.connect(analyser);
    drawState();
  } catch (e) {
    hardStop();
    if (lastOpts && lastOpts.onError) lastOpts.onError({ code: 'lost', message: 'جریان صوتی قطع شد و بازیابی خودکار ناموفق بود؛ دوباره میکروفن را روشن کنید.' });
  }
}

function cleanupAudioGraph(){
  if (micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  analyser = null; freqData = null; timeData = null;
}

export function stopListening(){
  wantListen = false;
  try { recognition && recognition.stop(); } catch (e) {}
  recognition = null;
  if (lastOpts && lastOpts.onState) lastOpts.onState(false);
  cleanupAudioGraph();
  drawState();
}

function hardStop(){
  wantListen = false;
  try { recognition && recognition.abort(); } catch (e) {}
  recognition = null;
  cleanupAudioGraph();
  if (lastOpts && lastOpts.onState) lastOpts.onState(false);
  drawState();
}
