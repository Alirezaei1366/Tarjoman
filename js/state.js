/* ═══════════ ترجمان — مخزن وضعیت متمرکز + رویدادها + کش محلی ═══════════ */
import { DEFAULTS, PERSIST_KEYS } from './config.js';

const LS_PREFIX = 'tarjoman:';
const CACHE_KEY = 'tarjoman:cache';
const listeners = new Map();

const state = { ...DEFAULTS, keys: [], models: [], modelCursor: 0, keyCursor: 0 };

function loadPersisted(){
  for (const k of PERSIST_KEYS){
    try {
      const raw = localStorage.getItem(LS_PREFIX + k);
      if (raw != null) state[k] = JSON.parse(raw);
    } catch (e) { /* داده خراب → مقدار پیش‌فرض می‌ماند */ }
  }
}
loadPersisted();

export function get(k){ return state[k]; }

export function on(ev, fn){
  if (!listeners.has(ev)) listeners.set(ev, new Set());
  listeners.get(ev).add(fn);
  return () => listeners.get(ev).delete(fn);
}

export function emit(ev, data){
  const s = listeners.get(ev);
  if (!s) return;
  for (const fn of [...s]){ try { fn(data); } catch (e) { console.error(e); } }
}

function persist(k){
  if (!PERSIST_KEYS.includes(k)) return;
  try { localStorage.setItem(LS_PREFIX + k, JSON.stringify(state[k])); } catch (e) { /* سهمیه پر است */ }
}

export function setSetting(k, v){ state[k] = v; persist(k); emit('change', { key: k, value: v }); }
export function setRuntime(k, v){ state[k] = v; emit('change', { key: k, value: v }); }

/* ───── استخر کلیدها ───── */
function uid(){ return (crypto.randomUUID ? crypto.randomUUID() : 'k' + Date.now() + Math.random().toString(36).slice(2)); }

export function addKeys(raw){
  const lines = String(raw || '').split(/[\s,;]+/).map(s => s.trim()).filter(s => s.length > 20);
  const existing = new Set(state.keys.map(k => k.key));
  let added = 0;
  for (const key of lines){
    if (existing.has(key)) continue;
    existing.add(key);
    state.keys.push({ id: uid(), key, status: 'active', cooldownUntil: 0, error: '', uses: 0 });
    added++;
  }
  persist('keys'); emit('keys');
  return added;
}

export function removeKey(id){
  state.keys = state.keys.filter(k => k.id !== id);
  persist('keys'); emit('keys');
}

export function patchKey(id, patch, silent = false){
  const k = state.keys.find(k => k.id === id);
  if (!k) return;
  Object.assign(k, patch);
  if (!silent){ persist('keys'); emit('keys'); }
}

/* انتخاب چرخشی کلید فعال + احیای خودکار کلیدهای خارج‌شده از خنک‌سازی */
export function nextKey(){
  const now = Date.now();
  let revived = false;
  for (const k of state.keys){
    if (k.status === 'cooldown' && k.cooldownUntil <= now){
      k.status = 'active'; k.cooldownUntil = 0; k.error = ''; revived = true;
    }
  }
  if (revived){ persist('keys'); emit('keys'); }
  const avail = state.keys.filter(k => k.status === 'active');
  if (!avail.length) return null;
  const k = avail[state.keyCursor % avail.length];
  state.keyCursor = (state.keyCursor + 1) % avail.length;
  patchKey(k.id, { uses: (k.uses || 0) + 1 }, true);
  return k;
}

export function coolKey(id, ms){
  patchKey(id, { status: 'cooldown', cooldownUntil: Date.now() + (ms || DEFAULTS.cooldownMs), error: '429 rate-limit' });
}
export function failKey(id, err){
  patchKey(id, { status: 'invalid', error: String(err).slice(0, 60) });
}

/* ───── کش ترجمه‌ها (LRU ساده با سقف اندازه/تعداد) ───── */
let cache = (() => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (e) { return {}; }
})();

export function cacheGet(k){ const e = cache[k]; return e ? e.v : null; }

export function cacheSet(k, v){
  if (typeof v !== 'string' || !v || v.length > 30000) return;
  try {
    cache[k] = { v, ts: Date.now() };
    const keys = Object.keys(cache);
    if (keys.length > 160){
      keys.sort((a, b) => cache[a].ts - cache[b].ts);
      for (const old of keys.slice(0, keys.length - 160)) delete cache[old];
    }
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (e) { /* سهمیه پر شد → کش اختیاری است */ }
}

export function cacheSize(){
  try { return (localStorage.getItem(CACHE_KEY) || '').length; } catch (e) { return 0; }
}

export function clearCache(){
  cache = {};
  try { localStorage.removeItem(CACHE_KEY); } catch (e) {}
  emit('toast', { msg: 'کش ترجمه‌ها پاک شد', type: 'ok' });
}
