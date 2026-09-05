/* ═══════════ ترجمان — پیکربندی مرکزی ═══════════ */

export const DEFAULTS = {
  theme: 'system',
  fontScale: 1,
  sourceLang: 'auto',
  targetLang: 'fa',
  tone: 'fluent',
  autoSend: true,
  autoSpeak: false,
  concurrency: 3,
  cooldownMs: 60000,
  chunkTokens: 1500,
  subBatch: 13,
  subContext: 3,
  cpsLimit: 17
};

export const PERSIST_KEYS = ['theme','fontScale','sourceLang','targetLang','tone','keys','autoSend','autoSpeak','concurrency'];

export const LANGS = [
  { code:'fa', fa:'فارسی',            en:'Persian (Farsi)',       asr:'fa-IR' },
  { code:'en', fa:'انگلیسی',          en:'English',               asr:'en-US' },
  { code:'ar', fa:'عربی',             en:'Arabic',                asr:'ar-SA' },
  { code:'tr', fa:'ترکی استانبولی',   en:'Turkish',               asr:'tr-TR' },
  { code:'de', fa:'آلمانی',           en:'German',                asr:'de-DE' },
  { code:'fr', fa:'فرانسوی',          en:'French',                asr:'fr-FR' },
  { code:'ru', fa:'روسی',             en:'Russian',               asr:'ru-RU' },
  { code:'es', fa:'اسپانیایی',        en:'Spanish',               asr:'es-ES' },
  { code:'it', fa:'ایتالیایی',        en:'Italian',               asr:'it-IT' },
  { code:'pt', fa:'پرتغالی',          en:'Portuguese',            asr:'pt-PT' },
  { code:'zh', fa:'چینی',             en:'Chinese (Simplified)',  asr:'zh-CN' },
  { code:'ja', fa:'ژاپنی',            en:'Japanese',              asr:'ja-JP' },
  { code:'ko', fa:'کره‌ای',            en:'Korean',                asr:'ko-KR' },
  { code:'hi', fa:'هندی',             en:'Hindi',                 asr:'hi-IN' },
  { code:'ur', fa:'اردو',             en:'Urdu',                  asr:'ur-PK' }
];

export const langByCode = c => LANGS.find(l => l.code === c);

export const TONE_PROMPTS = {
  fluent:  'You are a professional translator. Translate the user\'s text into {target}. Write fluent, natural, idiomatic prose exactly as an educated native speaker would. Output ONLY the translation — no notes, no quotes, no explanations.',
  street:  'You are a professional translator. Translate the user\'s text into {target}. Use very casual everyday spoken language — the way real people actually talk in the street. Slang and colloquial spelling are welcome when they fit. Output ONLY the translation.',
  formal:  'You are a professional translator. Translate the user\'s text into {target}. Use a formal, polished, official register suitable for business, legal and academic contexts. Output ONLY the translation.',
  literary:'You are a literary translator. Translate the user\'s text into {target}. Use an elegant literary style with rhythm, imagery and emotional depth, faithful to the artistic intent. Output ONLY the translation.'
};

export const TONE_WORDS = {
  fluent: 'natural and fluent',
  street: 'very casual, colloquial and spoken',
  formal: 'formal and professional',
  literary: 'literary and elegant'
};

export function tonePrompt(tone, targetEn){
  return (TONE_PROMPTS[tone] || TONE_PROMPTS.fluent).replaceAll('{target}', targetEn);
}

export const SUB_SYSTEM = (targetEn, cps) => `You are an elite subtitle translator for movies and TV series. You will receive numbered dialogue lines, each formatted "id ::: text". Lines formatted "CTX ::: ..." are PREVIOUS dialogue provided only for context (plot, jokes, tone, character relationships) — NEVER translate or output them.
STRICT RULES:
1. Reply with exactly one line per input id, formatted "id ::: translation". No commentary, no extra lines.
2. Keep placeholders such as §§TAG_0§§ EXACTLY as they are; never translate, reorder or drop them.
3. Keep each translation close to the source line length (within ±20%) so it stays readable at the original timing (target reading speed: max ${cps} characters per second).
4. Preserve each speaker's register: casual chat stays casual, formal speech stays formal.
5. If the target language is Persian, write in extremely colloquial spoken Tehran dialect (محاوره‌ی خودمونی کوچه‌ی تهران) — e.g. «می‌خوام، نمی‌دونم، بیا بریم، چه خبر» — never stiff written Persian, unless the line is clearly formal.
6. Keep jokes funny and idiomatic; keep character voices consistent with the context.
Target language: ${targetEn}.`;

export const OCR_PROMPT = (targetEn, tone) => `Look at the image carefully. First extract ALL visible text exactly as written, line by line (ignore graphical noise). Then translate it into ${targetEn} with a ${tone} register.
Respond in EXACTLY this format:
[TEXT]
<the extracted original text>
[TRANSLATION]
<the translation>
Nothing else outside these two sections.`;

export const DOC_PROMPT = (targetEn, tone) => `You are a professional document translator. Translate the user's document segment into ${targetEn}. Keep the original paragraph structure and line breaks. Overall register: ${tone}. Translate faithfully, fluently and completely. Output ONLY the translated text — no commentary, no headings of your own.`;
