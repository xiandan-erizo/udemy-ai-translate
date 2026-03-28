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

document.addEventListener('DOMContentLoaded', async () => {
  const $ = id => document.getElementById(id);
  const sync = await chrome.storage.sync.get(SYNC_DEFAULTS);
  const local = await chrome.storage.local.get({ apiKey: '' });

  $('targetLanguage').value = sync.targetLanguage;
  $('apiBaseUrl').value = sync.apiBaseUrl;
  $('model').value = sync.model;
  $('showOriginal').checked = sync.showOriginal;
  $('translateTranscript').checked = sync.translateTranscript;
  $('concurrencyLimit').value = clamp(sync.concurrencyLimit, 1, 8);
  $('captionFontSize').value = sync.captionFontSize;
  $('captionColor').value = sync.captionColor;
  $('apiKey').value = local.apiKey;
  $('customHeaders').value = sync.customHeaders;
  $('enableThinking').checked = sync.enableThinking;

  $('options-form').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await Promise.all([
        chrome.storage.sync.set({
          targetLanguage: $('targetLanguage').value.trim() || SYNC_DEFAULTS.targetLanguage,
          showOriginal: $('showOriginal').checked,
          translateTranscript: $('translateTranscript').checked,
          apiBaseUrl: $('apiBaseUrl').value.trim() || SYNC_DEFAULTS.apiBaseUrl,
          model: $('model').value.trim() || SYNC_DEFAULTS.model,
          concurrencyLimit: clamp($('concurrencyLimit').value, 1, 8),
          captionFontSize: $('captionFontSize').value.trim() || SYNC_DEFAULTS.captionFontSize,
          captionColor: $('captionColor').value,
          customHeaders: $('customHeaders').value.trim(),
          enableThinking: $('enableThinking').checked
        }),
        chrome.storage.local.set({ apiKey: $('apiKey').value.trim() })
      ]);
      showStatus('Saved!', 'success');
    } catch (e) {
      showStatus(e.message, 'error');
    }
  });

  $('clear-key').onclick = async () => {
    $('apiKey').value = '';
    await chrome.storage.local.set({ apiKey: '' });
    showStatus('Key removed', 'success');
  };

  $('clear-cache').onclick = () => {
    chrome.runtime.sendMessage({ type: 'clear-cache' }, r => {
      showStatus(r?.success ? 'Cache cleared' : 'Failed', r?.success ? 'success' : 'error');
    });
  };
});

function showStatus(msg, tone) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.dataset.tone = tone;
}

function clamp(v, min, max) {
  const n = Math.round(Number(v) || min);
  return Math.min(Math.max(n, min), max);
}