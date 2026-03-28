(() => {
  const CAPTION_SELECTORS = [
    '[data-purpose="captions-cue-text"]',
    'div[class*="captions-display--captions-cue-text"]'
  ];
  const TRANSCRIPT_TEXT_SELECTOR = 'span[data-purpose="cue-text"]';

  const SETTINGS_DEFAULTS = {
    showOriginal: true,
    translateTranscript: true,
    concurrencyLimit: 3,
    captionFontSize: '2.4rem',
    captionColor: '#b5e3ff'
  };

  const CONTEXT_WINDOW = 2;
  const TRACK_POLL_MS = 1500;
  const PRELOAD_COUNT = 5; // 预加载接下来的 5 条字幕

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
  let errorNoticeElement = null;
  let errorNoticeTimer = null;
  let lastPreloadTime = 0;

  const translationMemory = new Map();
  const transcriptHistory = [];
  const captionHistory = [];

  init();

  function init() {
    injectStyles();
    chrome.storage.sync.get(SETTINGS_DEFAULTS, stored => {
      settings = { ...SETTINGS_DEFAULTS, ...stored };
      settings.concurrencyLimit = sanitizeConcurrency(settings.concurrencyLimit);
      applyStyleSettings();
      startVideoWatcher();
      startCaptionWatcher();
      updateTranscriptWatcher();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const [key, change] of Object.entries(changes)) {
        if (!(key in settings)) continue;
        settings[key] = key === 'concurrencyLimit' ? sanitizeConcurrency(change.newValue) : change.newValue;
      }
      if ('translateTranscript' in changes) updateTranscriptWatcher();
      if ('captionFontSize' in changes || 'captionColor' in changes) applyStyleSettings();
      processTranscriptQueue();
      applyDisplayMode();
    });
  }

  function applyStyleSettings() {
    const root = document.documentElement;
    root.style.setProperty('--udemy-translator-caption-font-size', settings.captionFontSize || SETTINGS_DEFAULTS.captionFontSize);
    root.style.setProperty('--udemy-translator-caption-color', settings.captionColor || SETTINGS_DEFAULTS.captionColor);
  }

  // ===== 预加载 =====
  function preloadUpcomingCues() {
    if (!captionTrack || !videoElement) return;

    // 节流：每 2 秒最多预加载一次
    const now = Date.now();
    if (now - lastPreloadTime < 2000) return;
    lastPreloadTime = now;

    const cues = Array.from(captionTrack.cues || []);
    if (!cues.length) return;

    const currentTime = videoElement.currentTime;
    const upcoming = cues
      .filter(c => c.startTime > currentTime)
      .slice(0, PRELOAD_COUNT);

    if (!upcoming.length) return;
    console.log('[Udemy Translator] preloading', upcoming.length, 'cues');

    upcoming.forEach(cue => {
      const text = extractCueText(cue).trim();
      if (!text || translationMemory.has(text)) return;
      translateViaBackground({ text, context: [] })
        .then(r => {
          if (r?.success) {
            translationMemory.set(text, r.translatedText);
            console.log('[Udemy Translator] preloaded:', text.substring(0, 20));
          }
        })
        .catch(() => {});
    });
  }

  function extractCueText(cue) {
    if (!cue) return '';
    if (Array.isArray(cue.lines) && cue.lines.length) return cue.lines.join(' ');
    if (typeof cue.text === 'string') return cue.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return '';
  }

  // ===== Video Track 方式 =====
  function startVideoWatcher() {
    attachVideoIfAvailable();
    if (videoObserver) return;
    videoObserver = new MutationObserver(attachVideoIfAvailable);
    videoObserver.observe(document.body, { childList: true, subtree: true });
  }

  function attachVideoIfAvailable() {
    const video = document.querySelector('video');
    if (!video) return teardownVideo();
    if (video === videoElement) return;
    teardownVideo();
    videoElement = video;
    monitorTrackList();
    video.addEventListener('emptied', monitorTrackList);
    video.addEventListener('loadeddata', monitorTrackList);
    video.addEventListener('loadstart', monitorTrackList);
    video.addEventListener('timeupdate', preloadUpcomingCues); // 预加载
    trackPollTimer = setInterval(monitorTrackList, TRACK_POLL_MS);
  }

  function monitorTrackList() {
    if (!videoElement) return;
    const tracks = Array.from(videoElement.textTracks || []);
    if (!tracks.length) {
      if (usingTrackCaptions) teardownTrack();
      return;
    }
    const candidate = tracks.find(t => t.kind === 'captions' || t.kind === 'subtitles');
    if (!candidate) return;
    if (candidate === captionTrack) return;
    attachCaptionTrack(candidate);
  }

  function attachCaptionTrack(t) {
    teardownTrack();
    captionTrack = t;
    usingTrackCaptions = true;
    captionTrack.mode = 'hidden';
    captionTrackHandler = handleTrackCueChange;
    captionTrack.addEventListener('cuechange', captionTrackHandler);
    if (!captionTrack.cues?.length) captionTrack.addEventListener('load', captionTrackHandler, { once: true });
    const overlay = ensureOverlayElement();
    attachCaptionElement(overlay, { skipObserver: true });
    applyDisplayMode();
    handleTrackCueChange();

    // 预加载接下来的字幕
    preloadUpcomingCues();
  }

  function teardownTrack() {
    if (captionTrack && captionTrackHandler) captionTrack.removeEventListener('cuechange', captionTrackHandler);
    captionTrack = null;
    captionTrackHandler = null;
    usingTrackCaptions = false;
    captionElement = null;
    captionRequestId = 0;
    clearCaptionOverlay();
  }

  function teardownVideo() {
    if (trackPollTimer) clearInterval(trackPollTimer);
    trackPollTimer = null;
    if (videoElement) {
      videoElement.removeEventListener('emptied', monitorTrackList);
      videoElement.removeEventListener('loadeddata', monitorTrackList);
      videoElement.removeEventListener('loadstart', monitorTrackList);
      videoElement.removeEventListener('timeupdate', preloadUpcomingCues);
    }
    videoElement = null;
    teardownTrack();
  }

  function handleTrackCueChange() {
    if (!captionTrack) return;
    const cues = Array.from(captionTrack.activeCues || []);
    if (!cues.length) return clearCaptionOverlay();
    const text = cues.map(c => c.text || c.lines?.join(' ') || '').join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return clearCaptionOverlay();
    setOverlayOriginalText(text);
    handleCaptionText(text, { source: 'track' });
  }

  // ===== DOM Caption 方式 =====
  function startCaptionWatcher() {
    const attemptAttach = () => {
      if (usingTrackCaptions) return;
      const el = findCaptionElement();
      if (!el) return setTimeout(attemptAttach, 800);
      if (el !== captionElement) attachCaptionElement(el);
    };
    attemptAttach();

    new MutationObserver(() => {
      if (usingTrackCaptions) return;
      const el = findCaptionElement();
      if (el && el !== captionElement) attachCaptionElement(el);
    }).observe(document.body, { childList: true, subtree: true });
  }

  function attachCaptionElement(el, options = {}) {
    captionElement = el;
    captionElement.dataset.udemyTranslatorOriginal = captionElement.dataset.udemyTranslatorOriginal || '';
    if (captionObserver) captionObserver.disconnect();
    captionObserver = null;
    if (options.skipObserver) return;
    captionObserver = new MutationObserver(processCaptionFromDom);
    captionObserver.observe(el, { childList: true, subtree: true, characterData: true });
    processCaptionFromDom();
  }

  function processCaptionFromDom() {
    if (usingTrackCaptions || !captionElement) return;
    const text = extractOriginalFromCaption(captionElement);
    handleCaptionText(text, { source: 'dom' });
  }

  function extractOriginalFromCaption(el) {
    const orig = el.querySelector(':scope > .udemy-translator-original');
    if (orig) return (orig.textContent || '').trim();
    const trans = el.querySelector(':scope > .udemy-translator-translation');
    if (!trans) return (el.textContent || '').trim();
    return Array.from(el.childNodes).filter(c => c !== trans).map(c => c.textContent || '').join('').trim();
  }

  // ===== 通用字幕处理 =====
  function handleCaptionText(text, { source } = {}) {
    if (!text) return clearCaptionOverlay();
    if (source === 'track') {
      const overlay = ensureOverlayElement();
      if (captionElement !== overlay) attachCaptionElement(overlay, { skipObserver: true });
    }
    if (!captionElement || captionElement.dataset.udemyTranslatorOriginal === text) return;

    const ctx = captionHistory.slice(-CONTEXT_WINDOW);
    captionHistory.push(text);
    captionElement.dataset.udemyTranslatorOriginal = text;
    resetCaptionTranslation(captionElement);

    const cached = translationMemory.get(text);
    if (cached) return applyCaptionTranslation(captionElement, text, cached);

    const target = captionElement;
    const id = ++captionRequestId;

    translateViaBackground({ text, context: ctx })
      .then(r => {
        if (!r?.success || captionRequestId !== id) return;
        translationMemory.set(text, r.translatedText);
        applyCaptionTranslation(target, text, r.translatedText);
      })
      .catch(e => {
        console.warn('[Udemy Translator] caption error:', e.message);
        if (e.message === 'MISSING_API_KEY') showErrorNotice('请先配置 API Key');
        else if (e.message.includes('Extension context invalidated')) showErrorNotice('扩展已更新，请刷新页面');
        if (target?.dataset.udemyTranslatorOriginal === text) target.dataset.udemyTranslatorOriginal = '';
      });
  }

  function ensureOverlayElement() {
    if (overlayElement?.isConnected) return overlayElement;
    overlayElement = document.getElementById('udemy-translator-overlay');
    if (overlayElement?.isConnected) {
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
    overlayElement.append(overlayOriginalNode, overlayTranslationNode);
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
    if (overlayOriginalNode) overlayOriginalNode.textContent = '';
    if (overlayTranslationNode) overlayTranslationNode.textContent = '';
    if (overlayTranslationNode) overlayTranslationNode.style.display = 'none';
    if (overlayElement) overlayElement.style.display = 'none';
  }

  function resetCaptionTranslation(el) {
    const trans = ensureTranslationContainer(el);
    trans.textContent = '';
    trans.style.display = 'none';
    el.classList.remove('udemy-translator-hide-original');
  }

  function applyCaptionTranslation(el, orig, trans) {
    if (!el || el.dataset.udemyTranslatorOriginal !== orig) return;
    const node = ensureTranslationContainer(el);
    const text = typeof trans === 'string' ? trans.trim() : '';
    node.textContent = text;
    node.style.display = text ? 'block' : 'none';
    updateElementDisplayMode(el);
    if (el === overlayElement && text) el.style.display = 'flex';
  }

  function ensureTranslationContainer(el) {
    let node = el.querySelector(':scope > .udemy-translator-translation');
    if (!node) {
      node = document.createElement('div');
      node.className = 'udemy-translator-translation';
      node.style.display = 'none';
      el.appendChild(node);
    }
    return node;
  }

  // ===== Transcript =====
  function updateTranscriptWatcher() {
    if (!settings.translateTranscript) return destroyTranscriptWatcher();
    if (transcriptObserver) return;
    transcriptObserver = new MutationObserver(handleTranscriptMutations);
    transcriptObserver.observe(document.body, { childList: true, subtree: true });
    document.querySelectorAll(TRANSCRIPT_TEXT_SELECTOR).forEach(processTranscriptNode);
  }

  function destroyTranscriptWatcher() {
    if (transcriptObserver) transcriptObserver.disconnect();
    transcriptObserver = null;
    transcriptQueue = [];
    transcriptActive = 0;
  }

  function handleTranscriptMutations(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes || []) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches?.(TRANSCRIPT_TEXT_SELECTOR)) processTranscriptNode(node);
        else node.querySelectorAll?.(TRANSCRIPT_TEXT_SELECTOR)?.forEach(processTranscriptNode);
      }
    }
  }

  function processTranscriptNode(node) {
    const text = (node.textContent || '').trim();
    if (!text || node.dataset.udemyTranslatorOriginal === text) return;
    node.dataset.udemyTranslatorOriginal = text;
    ensureTranscriptTranslationContainer(node);
    const cached = translationMemory.get(text);
    if (cached) return applyTranscriptTranslation(node, text, cached);
    transcriptQueue.push({ node, text, ctx: transcriptHistory.slice(-CONTEXT_WINDOW) });
    transcriptHistory.push(text);
    processTranscriptQueue();
  }

  function ensureTranscriptTranslationContainer(node) {
    let t = node.parentElement?.querySelector(':scope > .udemy-translator-translation');
    if (!t) {
      t = document.createElement('div');
      t.className = 'udemy-translator-translation udemy-translator-translation--transcript';
      t.style.display = 'none';
      node.parentElement?.appendChild(t);
    }
    t.textContent = '';
    t.style.display = 'none';
    node.parentElement?.classList.remove('udemy-translator-hide-original');
  }

  function applyTranscriptTranslation(node, orig, trans) {
    if (!node?.parentElement || node.dataset.udemyTranslatorOriginal !== orig) return;
    const t = node.parentElement.querySelector(':scope > .udemy-translator-translation');
    if (!t) return;
    const text = typeof trans === 'string' ? trans.trim() : '';
    t.textContent = text;
    t.style.display = text ? 'block' : 'none';
    t.parentElement?.classList[settings.showOriginal ? 'remove' : 'add']('udemy-translator-hide-original');
  }

  function processTranscriptQueue() {
    while (transcriptActive < settings.concurrencyLimit && transcriptQueue.length) {
      transcriptActive++;
      const { node, text, ctx } = transcriptQueue.shift();
      translateViaBackground({ text, context: ctx })
        .then(r => {
          if (r?.success && node.dataset.udemyTranslatorOriginal === text) {
            translationMemory.set(text, r.translatedText);
            applyTranscriptTranslation(node, text, r.translatedText);
          }
        })
        .catch(() => {})
        .finally(() => { transcriptActive--; processTranscriptQueue(); });
    }
  }

  // ===== Utils =====
  function translateViaBackground({ text, context }) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translate', text, context }, r => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!r) reject(new Error('NO_RESPONSE'));
        else if (!r.success) reject(new Error(r.error));
        else resolve(r);
      });
    });
  }

  function applyDisplayMode() {
    if (captionElement) updateElementDisplayMode(captionElement);
    if (overlayElement) updateElementDisplayMode(overlayElement);
    document.querySelectorAll('.udemy-translator-translation--transcript').forEach(n => {
      n.parentElement?.classList[settings.showOriginal ? 'remove' : 'add']('udemy-translator-hide-original');
    });
  }

  function updateElementDisplayMode(el) {
    if (!el) return;
    el.classList[settings.showOriginal ? 'remove' : 'add']('udemy-translator-hide-original');
  }

  function showErrorNotice(msg) {
    if (errorNoticeTimer) clearTimeout(errorNoticeTimer);
    if (!errorNoticeElement?.isConnected) {
      errorNoticeElement = document.createElement('div');
      errorNoticeElement.id = 'udemy-translator-error-notice';
      document.body.appendChild(errorNoticeElement);
    }
    errorNoticeElement.textContent = msg;
    errorNoticeElement.style.display = 'block';
    errorNoticeTimer = setTimeout(() => { errorNoticeElement.style.display = 'none'; }, 5000);
  }

  function sanitizeConcurrency(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 8) : SETTINGS_DEFAULTS.concurrencyLimit;
  }

  function findCaptionElement() {
    for (const sel of CAPTION_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function injectStyles() {
    if (document.getElementById('udemy-translator-style')) return;
    const style = document.createElement('style');
    style.id = 'udemy-translator-style';
    style.textContent = `
      :root {
        --udemy-translator-caption-font-size: 2.4rem;
        --udemy-translator-caption-color: #b5e3ff;
      }
      #udemy-translator-error-notice {
        position: fixed; top: 20px; right: 20px; z-index: 99999;
        background: #ff4757; color: #fff; padding: 12px 16px; border-radius: 8px;
        font-size: 14px; font-weight: 500; display: none;
      }
      #udemy-translator-overlay {
        position: fixed; left: 50%; bottom: 12%; transform: translateX(-50%);
        z-index: 9999; pointer-events: none;
        display: flex; flex-direction: column; align-items: center; gap: 0.35em;
        text-align: center; max-width: min(80vw, 960px); padding: 0.35em 0.75em;
        text-shadow: 0 0 12px rgba(0,0,0,0.8);
      }
      #udemy-translator-overlay .udemy-translator-original { color: #fff; font-size: calc(var(--udemy-translator-caption-font-size) * 0.6); }
      #udemy-translator-overlay .udemy-translator-translation {
        font-size: var(--udemy-translator-caption-font-size); color: var(--udemy-translator-caption-color);
        font-weight: 500;
      }
      .udemy-translator-translation {
        font-size: var(--udemy-translator-caption-font-size); color: var(--udemy-translator-caption-color);
        text-shadow: 0 0 4px rgba(0,0,0,0.6);
      }
      .udemy-translator-translation--transcript { font-size: 0.85em; color: #2d7a2d; }
      .udemy-translator-hide-original > :not(.udemy-translator-translation) { display: none !important; }
    `;
    document.head.appendChild(style);
  }
})();