const SYNC_DEFAULTS = {
  targetLanguage: 'zh-CN',
  showOriginal: true,
  translateTranscript: true,
  apiBaseUrl: 'https://api.openai.com',
  model: 'gpt-4o-mini',
  concurrencyLimit: 3,
  captionFontSize: '2.4rem',
  captionColor: '#b5e3ff',
  customHeaders: '',
  enableThinking: false
};

const LOCAL_DEFAULTS = { apiKey: '' };

const CACHE_KEY = 'udemyTranslator.cache';
const CACHE_TTL = 24 * 60 * 60 * 1000;

const cache = new Map();
const pending = new Map();
const queue = [];
let activeJobs = 0, maxJobs = 3, cacheLoaded = false;

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (msg?.type === 'translate') {
    handleTranslate(msg, send);
    return true;
  }
  if (msg?.type === 'clear-cache') {
    cache.clear();
    chrome.storage.local.remove(CACHE_KEY).then(() => send({ success: true }));
    return true;
  }
});

async function handleTranslate(msg, send) {
  const text = msg.text?.trim();
  if (!text) return send({ success: false, error: 'EMPTY_TEXT' });

  const s = await getSettings();
  if (!s.apiKey) return send({ success: false, error: 'MISSING_API_KEY' });

  await loadCache();
  maxJobs = clamp(s.concurrencyLimit, 1, 8);

  const key = `${s.targetLanguage}::${s.model}::${text}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return send({ success: true, translatedText: cached.text, settings: s });
  }

  if (pending.has(key)) {
    return pending.get(key).then(r => send(r)).catch(e => send({ success: false, error: e.message }));
  }

  const ctx = (msg.context || []).slice(-2);
  const job = translate(text, ctx, s).then(result => {
    cache.set(key, { text: result, ts: Date.now() });
    saveCache();
    return { success: true, translatedText: result, settings: s };
  });

  pending.set(key, job);
  job.then(r => send(r)).catch(e => send({ success: false, error: e.message })).finally(() => pending.delete(key));
}

async function getSettings() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);
  return { ...SYNC_DEFAULTS, ...LOCAL_DEFAULTS, ...sync, ...local };
}

async function translate(text, ctx, s) {
  const prompt = ctx.length ? `[Prev: ${ctx.join(' → ')}]\n` : '';
  const body = {
    model: s.model || 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Translate subtitles precisely. No commentary.' },
      { role: 'user', content: `${prompt}Translate to ${s.targetLanguage}:\n"${text}"` }
    ],
    temperature: 0.2,
    enable_thinking: s.enableThinking ? true : false
  };

  let url = (s.apiBaseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  if (!/\/v\d+/.test(url)) url += '/v1';
  if (!/\/chat\/completions/.test(url)) url += '/chat/completions';

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` };
  const extra = parseHeaders(s.customHeaders);
  Object.assign(headers, extra);

  console.log('[Udemy Translator] Request:', url, body);

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json();
  console.log('[Udemy Translator] Response:', data?.usage);

  if (!res.ok) throw new Error(data?.error?.message || 'REQUEST_FAILED');
  const translated = data?.choices?.[0]?.message?.content?.trim();
  if (!translated) throw new Error('EMPTY_TRANSLATION');
  return translated;
}

function parseHeaders(str) {
  if (!str) return {};
  const out = {};
  for (const line of str.split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

async function loadCache() {
  if (cacheLoaded) return;
  const stored = await chrome.storage.local.get(CACHE_KEY);
  const now = Date.now();
  if (stored[CACHE_KEY]) {
    for (const [k, v] of Object.entries(stored[CACHE_KEY])) {
      if (now - v.ts < CACHE_TTL) cache.set(k, v);
    }
  }
  cacheLoaded = true;
}

function saveCache() {
  const payload = {};
  const now = Date.now();
  for (const [k, v] of cache.entries()) {
    if (now - v.ts < CACHE_TTL) payload[k] = v;
  }
  chrome.storage.local.set({ [CACHE_KEY]: payload });
}

function clamp(v, min, max) {
  const n = Math.round(Number(v) || min);
  return Math.min(Math.max(n, min), max);
}