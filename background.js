const SYNC_DEFAULTS = {
  targetLanguage: 'zh-CN',
  displayMode: 'stacked',
  showOriginal: true,
  translateTranscript: true,
  apiBaseUrl: 'https://api.openai.com',
  model: 'gpt-4o-mini',
  concurrencyLimit: 3,
  captionFontSize: '2.4rem',
  captionColor: '#b5e3ff'
};

const LOCAL_DEFAULTS = {
  apiKey: ''
};

const CACHE_STORAGE_KEY = 'udemyTranslator.cache';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_SAVE_DEBOUNCE_MS = 2000;

const translationCache = new Map(); // key -> { translation, timestamp }
const pendingRequests = new Map();
const jobQueue = [];

let activeJobs = 0;
let currentConcurrency = sanitizeConcurrency(SYNC_DEFAULTS.concurrencyLimit);
let cacheInitialized = false;
let cacheSaveTimer = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'translate') {
    handleTranslateRequest(message, sendResponse);
    return true;
  }

  if (message?.type === 'clear-cache') {
    clearTranslationCache()
      .then(() => sendResponse({ success: true }))
      .catch(error => {
        sendResponse({ success: false, error: error.message || 'CLEAR_FAILED' });
      });
    return true;
  }

  return false;
});

async function handleTranslateRequest(message, sendResponse) {
  try {
    const { text, context } = message;
    if (!text || !text.trim()) {
      sendResponse({ success: false, error: 'EMPTY_TEXT' });
      return;
    }

    const settings = await getSettings();
    if (!settings.apiKey) {
      sendResponse({ success: false, error: 'MISSING_API_KEY' });
      return;
    }

    await ensureCacheLoaded();

    const sanitizedConcurrency = sanitizeConcurrency(settings.concurrencyLimit);
    settings.concurrencyLimit = sanitizedConcurrency;
    updateConcurrency(sanitizedConcurrency);

    const cacheKey = buildCacheKey({
      text,
      targetLanguage: settings.targetLanguage,
      model: settings.model,
      apiBaseUrl: settings.apiBaseUrl
    });

    const cachedTranslation = getCachedTranslation(cacheKey);
    if (cachedTranslation) {
      sendResponse({ success: true, translatedText: cachedTranslation, settings });
      return;
    }

    if (pendingRequests.has(cacheKey)) {
      pendingRequests
        .get(cacheKey)
        .then(result => sendResponse(result))
        .catch(err => {
          sendResponse({ success: false, error: err.message });
        });
      return;
    }

    const contextLines = Array.isArray(context)
      ? context.map(line => (typeof line === 'string' ? line.trim() : '')).filter(Boolean).slice(-5)
      : [];

    const jobPromise = new Promise((resolve, reject) => {
      enqueueJob({
        text,
        context: contextLines,
        apiKey: settings.apiKey,
        targetLanguage: settings.targetLanguage,
        apiBaseUrl: settings.apiBaseUrl,
        model: settings.model,
        resolve,
        reject
      });
    }).then(translatedText => {
      rememberCacheEntry(cacheKey, translatedText);
      return { success: true, translatedText, settings };
    });

    pendingRequests.set(cacheKey, jobPromise);

    jobPromise
      .then(result => {
        sendResponse(result);
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message || 'TRANSLATION_FAILED' });
      })
      .finally(() => {
        pendingRequests.delete(cacheKey);
      });
  } catch (error) {
    sendResponse({ success: false, error: error.message || 'UNKNOWN_ERROR' });
  }
}

async function getSettings() {
  const [syncValues, localValues] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);
  return {
    ...SYNC_DEFAULTS,
    ...LOCAL_DEFAULTS,
    ...syncValues,
    ...localValues
  };
}

async function translateText({ text, apiKey, targetLanguage, apiBaseUrl, model, context }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  const contextLines = Array.isArray(context) ? context.filter(Boolean) : [];
  const contextBlock = contextLines.length ? `Context:\n${contextLines.join('\n')}\n\n` : '';
  const prompt = `Translate the following subtitle line into ${targetLanguage}. Provide translation only.\n\n${contextBlock}Subtitle:\n${text}`;

  let endpoint = (apiBaseUrl || 'https://api.openai.com').trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    endpoint = 'https://api.openai.com';
  }
  endpoint = endpoint.replace(/\/+$/, '');
  if (/\/(chat\/completions|responses)(?:\/|$)/i.test(endpoint)) {
    // already points to a full endpoint such as /v1/chat/completions or /v1/responses
  } else if (/\/v\d+$/i.test(endpoint)) {
    endpoint = `${endpoint}/chat/completions`;
  } else {
    endpoint = `${endpoint}/v1/chat/completions`;
  }
  const modelName = model || 'gpt-4o-mini';

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        {
          role: 'system',
          content: 'You are a precise subtitle translator. Keep timing subtleties and concise language. Avoid adding commentary.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.2,
      max_tokens: 200
    }),
    signal: controller.signal
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const errorPayload = await safeJson(response);
    const reason = errorPayload?.error?.message || response.statusText || 'REQUEST_FAILED';
    throw new Error(reason);
  }

  const data = await response.json();
  const translated = data?.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error('EMPTY_TRANSLATION');
  }
  return translated;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function enqueueJob(job) {
  jobQueue.push(job);
  pumpQueue();
}

function pumpQueue() {
  while (activeJobs < currentConcurrency && jobQueue.length) {
    const job = jobQueue.shift();
    activeJobs++;
    runJob(job);
  }
}

async function runJob(job) {
  try {
    const translated = await translateText(job);
    job.resolve(translated);
  } catch (error) {
    job.reject(error);
  } finally {
    activeJobs = Math.max(0, activeJobs - 1);
    pumpQueue();
  }
}

function updateConcurrency(limit) {
  const sanitized = sanitizeConcurrency(limit);
  if (sanitized !== currentConcurrency) {
    currentConcurrency = sanitized;
    pumpQueue();
  }
}

function sanitizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return SYNC_DEFAULTS.concurrencyLimit;
  }
  return Math.min(Math.max(Math.round(num), 1), 8);
}

function buildCacheKey({ text, targetLanguage, model, apiBaseUrl }) {
  return [
    targetLanguage || '',
    model || '',
    apiBaseUrl || '',
    text || ''
  ].join('::');
}

async function ensureCacheLoaded() {
  if (cacheInitialized) return;
  try {
    const stored = await chrome.storage.local.get(CACHE_STORAGE_KEY);
    const data = stored?.[CACHE_STORAGE_KEY];
    const now = Date.now();
    if (data && typeof data === 'object') {
      for (const [key, entry] of Object.entries(data)) {
        if (
          entry &&
          typeof entry.translation === 'string' &&
          typeof entry.timestamp === 'number' &&
          now - entry.timestamp <= CACHE_TTL_MS
        ) {
          translationCache.set(key, {
            translation: entry.translation,
            timestamp: entry.timestamp
          });
        }
      }
    }
  } catch (error) {
    console.warn('[Udemy Translator] Failed to load cache', error);
  } finally {
    cacheInitialized = true;
  }
}

function getCachedTranslation(key) {
  const entry = translationCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    translationCache.delete(key);
    scheduleCacheSave();
    return null;
  }
  return entry.translation;
}

function rememberCacheEntry(key, translation) {
  if (!translation) return;
  translationCache.set(key, {
    translation,
    timestamp: Date.now()
  });
  scheduleCacheSave();
}

function scheduleCacheSave() {
  if (!cacheInitialized) return;
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
  }
  cacheSaveTimer = setTimeout(() => {
    cacheSaveTimer = null;
    saveCacheToStorage().catch(error => {
      console.warn('[Udemy Translator] Failed to persist cache', error);
    });
  }, CACHE_SAVE_DEBOUNCE_MS);
}

async function saveCacheToStorage() {
  await ensureCacheLoaded();
  const now = Date.now();
  const payload = {};

  for (const [key, entry] of translationCache.entries()) {
    if (now - entry.timestamp <= CACHE_TTL_MS) {
      payload[key] = entry;
    } else {
      translationCache.delete(key);
    }
  }

  if (Object.keys(payload).length) {
    await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: payload });
  } else {
    await chrome.storage.local.remove(CACHE_STORAGE_KEY);
  }
}

async function clearTranslationCache() {
  await ensureCacheLoaded();
  translationCache.clear();
  if (cacheSaveTimer) {
    clearTimeout(cacheSaveTimer);
    cacheSaveTimer = null;
  }
  await chrome.storage.local.remove(CACHE_STORAGE_KEY);
}
