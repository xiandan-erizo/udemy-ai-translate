const SYNC_DEFAULTS = {
  targetLanguage: 'zh-CN',
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

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('options-form');
  const apiKeyInput = document.getElementById('apiKey');
  const apiBaseUrlInput = document.getElementById('apiBaseUrl');
  const targetLanguageInput = document.getElementById('targetLanguage');
  const showOriginalInput = document.getElementById('showOriginal');
  const translateTranscriptInput = document.getElementById('translateTranscript');
  const modelInput = document.getElementById('model');
  const concurrencyInput = document.getElementById('concurrencyLimit');
  const captionFontSizeInput = document.getElementById('captionFontSize');
  const captionColorInput = document.getElementById('captionColor');
  const clearKeyButton = document.getElementById('clear-key');
  const clearCacheButton = document.getElementById('clear-cache');
  const statusNode = document.getElementById('status');

  const [syncValues, localValues] = await Promise.all([
    chrome.storage.sync.get(SYNC_DEFAULTS),
    chrome.storage.local.get(LOCAL_DEFAULTS)
  ]);

  targetLanguageInput.value = syncValues.targetLanguage || SYNC_DEFAULTS.targetLanguage;
  apiBaseUrlInput.value = syncValues.apiBaseUrl || SYNC_DEFAULTS.apiBaseUrl;
  modelInput.value = syncValues.model || SYNC_DEFAULTS.model;
  showOriginalInput.checked =
    typeof syncValues.showOriginal === 'boolean' ? syncValues.showOriginal : SYNC_DEFAULTS.showOriginal;
  translateTranscriptInput.checked =
    typeof syncValues.translateTranscript === 'boolean'
      ? syncValues.translateTranscript
      : SYNC_DEFAULTS.translateTranscript;
  const concurrencyLimit = sanitizeConcurrency(syncValues.concurrencyLimit);
  concurrencyInput.value = concurrencyLimit;
  captionFontSizeInput.value = (syncValues.captionFontSize || SYNC_DEFAULTS.captionFontSize).trim();
  captionColorInput.value = normalizeColor(syncValues.captionColor);
  apiKeyInput.value = localValues.apiKey || '';

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearStatus(statusNode);
    const apiKey = apiKeyInput.value.trim();
    const targetLanguage = targetLanguageInput.value.trim() || SYNC_DEFAULTS.targetLanguage;
    const showOriginal = showOriginalInput.checked;
    const translateTranscript = translateTranscriptInput.checked;
    const apiBaseUrl = apiBaseUrlInput.value.trim() || SYNC_DEFAULTS.apiBaseUrl;
    const model = modelInput.value.trim() || SYNC_DEFAULTS.model;
    const concurrencyLimitValue = sanitizeConcurrency(concurrencyInput.value);
    concurrencyInput.value = concurrencyLimitValue;
    const captionFontSize = captionFontSizeInput.value.trim() || SYNC_DEFAULTS.captionFontSize;
    const captionColor = normalizeColor(captionColorInput.value);
    captionColorInput.value = captionColor;

    try {
      await Promise.all([
        chrome.storage.sync.set({
          targetLanguage,
          showOriginal,
          translateTranscript,
          apiBaseUrl,
          model,
          concurrencyLimit: concurrencyLimitValue,
          captionFontSize,
          captionColor
        }),
        chrome.storage.local.set({ apiKey })
      ]);
      renderStatus(statusNode, 'Settings saved.', 'success');
    } catch (error) {
      renderStatus(statusNode, error.message || 'Failed to save settings.', 'error');
    }
  });

  clearKeyButton.addEventListener('click', async () => {
    clearStatus(statusNode);
    apiKeyInput.value = '';
    try {
      await chrome.storage.local.set({ apiKey: '' });
      renderStatus(statusNode, 'API key removed.', 'success');
    } catch (error) {
      renderStatus(statusNode, error.message || 'Unable to clear key.', 'error');
    }
  });

  clearCacheButton.addEventListener('click', () => {
    clearStatus(statusNode);
    chrome.runtime.sendMessage({ type: 'clear-cache' }, response => {
      if (chrome.runtime.lastError) {
        renderStatus(statusNode, chrome.runtime.lastError.message, 'error');
        return;
      }
      if (!response?.success) {
        renderStatus(statusNode, response?.error || 'Failed to clear cache.', 'error');
        return;
      }
      renderStatus(statusNode, 'Translation cache cleared.', 'success');
    });
  });
});

function renderStatus(node, message, tone = 'info') {
  node.textContent = message;
  node.dataset.tone = tone;
}

function clearStatus(node) {
  node.textContent = '';
  delete node.dataset.tone;
}

function sanitizeConcurrency(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return SYNC_DEFAULTS.concurrencyLimit;
  }
  return Math.min(Math.max(Math.round(num), 1), 8);
}

function normalizeColor(value) {
  const stringValue = (value || '').toString().trim();
  if (/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(stringValue)) {
    return stringValue.length === 4
      ? `#${[1, 2, 3].map(i => stringValue[i] + stringValue[i]).join('')}`
      : stringValue.toLowerCase();
  }
  return SYNC_DEFAULTS.captionColor;
}
