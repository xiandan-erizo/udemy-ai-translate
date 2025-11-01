(() => {
  const CAPTION_SELECTORS = [
    '[data-purpose="captions-cue-text"]',
    'div[class*="captions-display--captions-cue-text"]'
  ];
  const TRANSCRIPT_TEXT_SELECTOR = 'span[data-purpose="cue-text"]';

  const SETTINGS_DEFAULTS = {
    displayMode: 'stacked',
    showOriginal: true,
    translateTranscript: true,
    concurrencyLimit: 3,
    captionFontSize: '2.4rem',
    captionColor: '#b5e3ff'
  };

  const CONTEXT_WINDOW = 3;
  const HISTORY_LIMIT = 80;
  const TRANSCRIPT_THROTTLE_MS = 80;
  const TRACK_POLL_MS = 1500;

  let settings = { ...SETTINGS_DEFAULTS };
  let captionObserver = null;
  let captionElement = null;
  let captionRequestId = 0;
  let transcriptObserver = null;
  let transcriptQueue = [];
  let transcriptActive = 0;
  let videoObserver = null;
  let videoElement = null;
  let trackPollTimer = null;
  let captionTrack = null;
  let captionTrackHandler = null;
  let usingTrackCaptions = false;
  let overlayElement = null;
  let overlayOriginalNode = null;
  let overlayTranslationNode = null;

  const translationMemory = new Map();
  const transcriptHistory = [];
  const captionHistory = [];

  init();

  function init() {
    injectStyles();
    chrome.storage.sync.get(SETTINGS_DEFAULTS, stored => {
      settings = {
        ...SETTINGS_DEFAULTS,
        ...stored
      };
      settings.concurrencyLimit = sanitizeConcurrency(settings.concurrencyLimit);
      applyStyleSettings();
      startVideoWatcher();
      startCaptionWatcher();
      updateTranscriptWatcher();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      let restartTranscript = false;
      let refreshStyles = false;
      for (const [key, change] of Object.entries(changes)) {
        if (!(key in settings)) continue;
        if (key === 'concurrencyLimit') {
          settings[key] = sanitizeConcurrency(change.newValue);
        } else {
          settings[key] = change.newValue;
        }
        if (key === 'translateTranscript') {
          restartTranscript = true;
        }
        if (key === 'captionFontSize' || key === 'captionColor') {
          refreshStyles = true;
        }
      }
      if (restartTranscript) {
        updateTranscriptWatcher();
      }
      if (refreshStyles) {
        applyStyleSettings();
      }
      processTranscriptQueue();
      applyDisplayMode();
    });
  }

  function applyStyleSettings() {
    const root = document.documentElement;
    root.style.setProperty(
      '--udemy-translator-caption-font-size',
      settings.captionFontSize || SETTINGS_DEFAULTS.captionFontSize
    );
    root.style.setProperty(
      '--udemy-translator-caption-color',
      settings.captionColor || SETTINGS_DEFAULTS.captionColor
    );
  }

  function startVideoWatcher() {
    attachVideoIfAvailable();
    if (videoObserver) return;
    videoObserver = new MutationObserver(() => {
      attachVideoIfAvailable();
    });
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function attachVideoIfAvailable() {
    const video = document.querySelector('video');
    if (!video) {
      teardownVideo();
      return;
    }
    if (video === videoElement) {
      return;
    }
    teardownVideo();
    videoElement = video;
    monitorTrackList();
    video.addEventListener('emptied', monitorTrackList);
    video.addEventListener('loadeddata', monitorTrackList);
    video.addEventListener('loadstart', monitorTrackList);
    trackPollTimer = setInterval(monitorTrackList, TRACK_POLL_MS);
  }

  function monitorTrackList() {
    if (!videoElement) return;
    const tracks = Array.from(videoElement.textTracks || []);
    if (!tracks.length) {
      if (usingTrackCaptions) {
        teardownTrack();
      }
      return;
    }

    const candidate =
      tracks.find(track => track.kind === 'captions' && track.language) ||
      tracks.find(track => track.kind === 'subtitles' && track.language) ||
      tracks.find(track => track.kind === 'captions') ||
      tracks.find(track => track.kind === 'subtitles');

    if (!candidate) {
      return;
    }
    if (candidate === captionTrack) {
      return;
    }
    attachCaptionTrack(candidate);
  }

  function attachCaptionTrack(track) {
    teardownTrack();
    captionTrack = track;
    usingTrackCaptions = true;
    captionTrack.mode = 'hidden';
    captionTrackHandler = () => handleTrackCueChange();
    captionTrack.addEventListener('cuechange', captionTrackHandler);
    if (captionTrack.cues?.length === 0) {
      captionTrack.addEventListener('load', captionTrackHandler, { once: true });
    }
    const overlay = ensureOverlayElement();
    attachCaptionElement(overlay, { skipObserver: true });
    applyDisplayMode();
    handleTrackCueChange();
  }

  function teardownTrack() {
    if (captionTrack && captionTrackHandler) {
      captionTrack.removeEventListener('cuechange', captionTrackHandler);
    }
    captionTrack = null;
    captionTrackHandler = null;
    usingTrackCaptions = false;
    captionElement = null;
    captionRequestId = 0;
    clearCaptionOverlay();
  }

  function teardownVideo() {
    if (trackPollTimer) {
      clearInterval(trackPollTimer);
      trackPollTimer = null;
    }
    if (videoElement) {
      videoElement.removeEventListener('emptied', monitorTrackList);
      videoElement.removeEventListener('loadeddata', monitorTrackList);
      videoElement.removeEventListener('loadstart', monitorTrackList);
    }
    videoElement = null;
    teardownTrack();
  }

  function handleTrackCueChange() {
    if (!captionTrack) return;
    const cues = Array.from(captionTrack.activeCues || []);
    if (!cues.length) {
      clearCaptionOverlay();
      return;
    }

    const combined = cues
      .map(extractCueText)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!combined) {
      clearCaptionOverlay();
      return;
    }

    setOverlayOriginalText(combined);
    handleCaptionText(combined, { source: 'track' });
  }

  function extractCueText(cue) {
    if (!cue) return '';
    if (Array.isArray(cue.lines) && cue.lines.length) {
      return cue.lines.join(' ');
    }
    if (typeof cue.text === 'string') {
      return cue.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return '';
  }

  function startCaptionWatcher() {
    const attemptAttach = () => {
      if (usingTrackCaptions) {
        return;
      }
      const element = findCaptionElement();
      if (!element) {
        setTimeout(attemptAttach, 800);
        return;
      }
      if (element !== captionElement) {
        attachCaptionElement(element);
      }
    };
    attemptAttach();

    const bodyObserver = new MutationObserver(() => {
      if (usingTrackCaptions) {
        return;
      }
      const element = findCaptionElement();
      if (element && element !== captionElement) {
        attachCaptionElement(element);
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  function attachCaptionElement(element, options = {}) {
    captionElement = element;
    captionElement.dataset.udemyTranslatorOriginal = captionElement.dataset.udemyTranslatorOriginal || '';
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    if (options.skipObserver) {
      return;
    }
    captionObserver = new MutationObserver(() => {
      processCaptionFromDom();
    });
    captionObserver.observe(element, { childList: true, subtree: true, characterData: true });
    processCaptionFromDom();
  }

  function processCaptionFromDom() {
    if (usingTrackCaptions) return;
    if (!captionElement) return;
    const originalText = extractOriginalFromCaption(captionElement);
    handleCaptionText(originalText, { source: 'dom' });
  }

  function extractOriginalFromCaption(element) {
    const overlayOriginal = element.querySelector(':scope > .udemy-translator-original');
    if (overlayOriginal) {
      return (overlayOriginal.textContent || '').trim();
    }
    const translationNode = element.querySelector(':scope > .udemy-translator-translation');
    if (!translationNode) {
      return (element.textContent || '').trim();
    }
    const nodes = [];
    for (const child of element.childNodes) {
      if (child !== translationNode) {
        nodes.push(child.textContent || '');
      }
    }
    return nodes.join('').trim();
  }

  function handleCaptionText(originalText, { source } = {}) {
    if (!originalText) {
      clearCaptionOverlay();
      return;
    }

    if (source === 'track') {
      const overlay = ensureOverlayElement();
      if (captionElement !== overlay) {
        attachCaptionElement(overlay, { skipObserver: true });
      }
    }

    if (!captionElement) return;
    if (captionElement.dataset.udemyTranslatorOriginal === originalText) {
      return;
    }

    const context = getRecentContext(captionHistory);
    pushHistory(captionHistory, originalText);

    captionElement.dataset.udemyTranslatorOriginal = originalText;
    resetCaptionTranslation(captionElement);
    const cached = translationMemory.get(originalText);
    if (cached) {
      applyCaptionTranslation(captionElement, originalText, cached);
      return;
    }

    const targetElement = captionElement;
    const currentRequestId = ++captionRequestId;

    translateViaBackground({ text: originalText, context })
      .then(result => {
        if (!result?.success || captionRequestId !== currentRequestId) {
          return;
        }
        memoizeTranslation(originalText, result.translatedText);
        applyCaptionTranslation(targetElement, originalText, result.translatedText);
      })
      .catch(error => {
        console.warn('[Udemy Translator] caption translation failed', error);
        if (targetElement?.dataset.udemyTranslatorOriginal === originalText) {
          targetElement.dataset.udemyTranslatorOriginal = '';
        }
      });
  }

  function ensureOverlayElement() {
    if (overlayElement && overlayElement.isConnected) {
      return overlayElement;
    }
    overlayElement = document.getElementById('udemy-translator-overlay');
    if (overlayElement && overlayElement.isConnected) {
      overlayOriginalNode = overlayElement.querySelector(':scope > .udemy-translator-original');
      overlayTranslationNode = overlayElement.querySelector(':scope > .udemy-translator-translation');
      return overlayElement;
    }
    overlayElement = document.createElement('div');
    overlayElement.id = 'udemy-translator-overlay';
    overlayElement.className = 'udemy-translator-overlay';
    overlayOriginalNode = document.createElement('div');
    overlayOriginalNode.className = 'udemy-translator-original';
    overlayTranslationNode = document.createElement('div');
    overlayTranslationNode.className = 'udemy-translator-translation';
    overlayElement.appendChild(overlayOriginalNode);
    overlayElement.appendChild(overlayTranslationNode);
    overlayElement.style.display = 'none';
    document.body.appendChild(overlayElement);
    return overlayElement;
  }

  function setOverlayOriginalText(text) {
    const overlay = ensureOverlayElement();
    overlayOriginalNode.textContent = text || '';
    overlay.style.display = text ? 'flex' : 'none';
  }

  function clearCaptionOverlay() {
    if (overlayOriginalNode) {
      overlayOriginalNode.textContent = '';
    }
    if (overlayTranslationNode) {
      overlayTranslationNode.textContent = '';
      overlayTranslationNode.style.display = 'none';
    }
    if (overlayElement) {
      overlayElement.style.display = 'none';
      overlayElement.dataset.udemyTranslatorOriginal = '';
    }
  }

  function resetCaptionTranslation(element) {
    const translationNode = ensureTranslationContainer(element);
    translationNode.textContent = '';
    translationNode.style.display = 'none';
    element.classList.remove('udemy-translator-hide-original');
  }

  function applyCaptionTranslation(element, original, translation) {
    if (!element || element.dataset.udemyTranslatorOriginal !== original) {
      return;
    }
    const translationNode = ensureTranslationContainer(element);
    const output = typeof translation === 'string' ? translation.trim() : '';
    translationNode.textContent = output;
    translationNode.style.display = output ? 'block' : 'none';
    updateElementDisplayMode(element);
    if (element === overlayElement && output) {
      element.style.display = 'flex';
    }
  }

  function ensureTranslationContainer(element) {
    let translationNode = element.querySelector(':scope > .udemy-translator-translation');
    if (!translationNode) {
      translationNode = document.createElement('div');
      translationNode.className = 'udemy-translator-translation';
      translationNode.style.display = 'none';
      element.appendChild(translationNode);
    }
    return translationNode;
  }

  function updateTranscriptWatcher() {
    if (!settings.translateTranscript) {
      destroyTranscriptWatcher();
      return;
    }
    if (!transcriptObserver) {
      transcriptObserver = new MutationObserver(handleTranscriptMutations);
      transcriptObserver.observe(document.body, { childList: true, subtree: true });
      seedExistingTranscriptNodes();
    }
  }

  function destroyTranscriptWatcher() {
    if (transcriptObserver) {
      transcriptObserver.disconnect();
      transcriptObserver = null;
    }
    transcriptQueue = [];
    transcriptActive = 0;
  }

  function handleTranscriptMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes || []) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(TRANSCRIPT_TEXT_SELECTOR)) {
          processTranscriptNode(node);
        } else {
          const matches = node.querySelectorAll?.(TRANSCRIPT_TEXT_SELECTOR);
          matches?.forEach(processTranscriptNode);
        }
      }
    }
  }

  function seedExistingTranscriptNodes() {
    document.querySelectorAll(TRANSCRIPT_TEXT_SELECTOR).forEach(processTranscriptNode);
  }

  function processTranscriptNode(node) {
    const originalText = (node.textContent || '').trim();
    if (!originalText) return;
    if (node.dataset.udemyTranslatorOriginal === originalText) return;
    node.dataset.udemyTranslatorOriginal = originalText;
    ensureTranscriptTranslationContainer(node);
    const context = getRecentContext(transcriptHistory);
    pushHistory(transcriptHistory, originalText);
    const cached = translationMemory.get(originalText);
    if (cached) {
      applyTranscriptTranslation(node, originalText, cached);
      return;
    }
    enqueueTranscriptTranslation(node, originalText, context);
  }

  function ensureTranscriptTranslationContainer(node) {
    let translation = node.parentElement?.querySelector(':scope > .udemy-translator-translation');
    if (!translation) {
      translation = document.createElement('div');
      translation.className = 'udemy-translator-translation udemy-translator-translation--transcript';
      translation.style.display = 'none';
      node.parentElement?.appendChild(translation);
    }
    translation.textContent = '';
    translation.style.display = 'none';
    node.parentElement?.classList.remove('udemy-translator-hide-original');
  }

  function applyTranscriptTranslation(node, originalText, translation) {
    if (!node?.parentElement) return;
    if (node.dataset.udemyTranslatorOriginal !== originalText) return;
    const translationNode = node.parentElement.querySelector(':scope > .udemy-translator-translation');
    if (!translationNode) return;
    const output = typeof translation === 'string' ? translation.trim() : '';
    translationNode.textContent = output;
    translationNode.style.display = output ? 'block' : 'none';
    if (settings.showOriginal) {
      translationNode.parentElement?.classList.remove('udemy-translator-hide-original');
    } else {
      translationNode.parentElement?.classList.add('udemy-translator-hide-original');
    }
  }

  function enqueueTranscriptTranslation(node, originalText, context) {
    transcriptQueue.push({ node, originalText, context });
    processTranscriptQueue();
  }

  function processTranscriptQueue() {
    const limit = sanitizeConcurrency(settings.concurrencyLimit);
    while (transcriptActive < limit && transcriptQueue.length) {
      const job = transcriptQueue.shift();
      transcriptActive++;
      processTranscriptJob(job)
        .catch(error => {
          console.warn('[Udemy Translator] transcript translation failed', error);
        })
        .finally(() => {
          transcriptActive = Math.max(0, transcriptActive - 1);
          processTranscriptQueue();
        });
    }
  }

  async function processTranscriptJob({ node, originalText, context }) {
    if (!node?.isConnected) {
      await delay(TRANSCRIPT_THROTTLE_MS);
      return;
    }
    const cached = translationMemory.get(originalText);
    if (cached) {
      applyTranscriptTranslation(node, originalText, cached);
      await delay(TRANSCRIPT_THROTTLE_MS);
      return;
    }
    try {
      const result = await translateViaBackground({ text: originalText, context });
      if (result?.success && node.dataset.udemyTranslatorOriginal === originalText) {
        applyTranscriptTranslation(node, originalText, result.translatedText);
        memoizeTranslation(originalText, result.translatedText, { updateCaption: true });
      }
    } finally {
      await delay(TRANSCRIPT_THROTTLE_MS);
    }
  }

  function translateViaBackground({ text, context = [] }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translate', text, context }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('NO_RESPONSE'));
          return;
        }
        if (!response.success) {
          reject(new Error(response.error || 'TRANSLATION_FAILED'));
          return;
        }
        resolve(response);
      });
    });
  }

  function applyDisplayMode() {
    if (captionElement) {
      updateElementDisplayMode(captionElement);
    }
    if (overlayElement) {
      updateElementDisplayMode(overlayElement);
    }
    document.querySelectorAll('.udemy-translator-translation--transcript').forEach(node => {
      const container = node.parentElement;
      if (!container) return;
      if (settings.showOriginal) {
        container.classList.remove('udemy-translator-hide-original');
      } else {
        container.classList.add('udemy-translator-hide-original');
      }
    });
  }

  function updateElementDisplayMode(element) {
    if (!element) return;
    if (settings.showOriginal) {
      element.classList.remove('udemy-translator-hide-original');
    } else {
      element.classList.add('udemy-translator-hide-original');
    }
  }

  function memoizeTranslation(original, translation, options = {}) {
    if (!original || !translation) return;
    const normalized = typeof translation === 'string' ? translation.trim() : '';
    if (!normalized) return;
    translationMemory.set(original, normalized);
    if (options.updateCaption && captionElement && captionElement.dataset.udemyTranslatorOriginal === original) {
      const container = captionElement.querySelector(':scope > .udemy-translator-translation');
      const current = container?.textContent?.trim() || '';
      if (current !== normalized) {
        applyCaptionTranslation(captionElement, original, normalized);
      }
    }
  }

  function pushHistory(history, value) {
    if (!value) return;
    history.push(value);
    if (history.length > HISTORY_LIMIT) {
      history.splice(0, history.length - HISTORY_LIMIT);
    }
  }

  function getRecentContext(history) {
    if (!history?.length) return [];
    return history.slice(-CONTEXT_WINDOW);
  }

  function sanitizeConcurrency(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) {
      return SETTINGS_DEFAULTS.concurrencyLimit;
    }
    return Math.min(Math.max(Math.round(num), 1), 8);
  }

  function findCaptionElement() {
    for (const selector of CAPTION_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    return null;
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function injectStyles() {
    if (document.getElementById('udemy-translator-style')) return;
    const style = document.createElement('style');
    style.id = 'udemy-translator-style';
    style.textContent = `
      :root {
        --udemy-translator-caption-font-size: 2.4rem;
        --udemy-translator-caption-color: #b5e3ff;
        --udemy-translator-transcript-font-size: 0.85em;
        --udemy-translator-transcript-color: #2d7a2d;
      }

      #udemy-translator-overlay {
        position: fixed;
        left: 50%;
        bottom: 12%;
        transform: translateX(-50%);
        z-index: 9999;
        pointer-events: none;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35em;
        text-align: center;
        max-width: min(80vw, 960px);
        padding: 0.35em 0.75em;
        text-shadow: 0 0 12px rgba(0, 0, 0, 0.8);
      }

      .udemy-translator-overlay .udemy-translator-original,
      #udemy-translator-overlay .udemy-translator-original {
        color: #fff;
        font-size: calc(var(--udemy-translator-caption-font-size, 2.4rem) * 0.6);
        line-height: 1.2;
      }

      .udemy-translator-overlay .udemy-translator-translation,
      #udemy-translator-overlay .udemy-translator-translation {
        margin-top: 0.15em;
        font-size: var(--udemy-translator-caption-font-size, 2.4rem);
        line-height: 1.25;
        color: var(--udemy-translator-caption-color, #b5e3ff);
        font-weight: 500;
      }

      .udemy-translator-translation {
        margin-top: 0.35em;
        font-size: var(--udemy-translator-caption-font-size, 2.4rem);
        line-height: 1.2;
        color: var(--udemy-translator-caption-color, #b5e3ff);
        text-shadow: 0 0 4px rgba(0,0,0,0.6);
        font-weight: 400;
      }

      .udemy-translator-translation--transcript {
        margin-top: 0.2em;
        font-size: var(--udemy-translator-transcript-font-size, 0.85em);
        color: var(--udemy-translator-transcript-color, #2d7a2d);
        text-shadow: none;
      }

      .udemy-translator-hide-original > :not(.udemy-translator-translation) {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }
})();
