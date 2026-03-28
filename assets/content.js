(() => {
  const TRANSCRIPT_SELECTOR = 'span[data-purpose="cue-text"]';

  const DEFAULTS = {
    showOriginal: true,
    translateTranscript: true,
    concurrencyLimit: 3,
    captionFontSize: '2.4rem',
    captionColor: '#b5e3ff'
  };

  const mem = new Map();
  const history = [];
  let settings = { ...DEFAULTS };
  let video = null, track = null, overlay = null, overlayOrig = null, overlayTrans = null;
  let captionEl = null, requestId = 0, transQueue = [], transActive = 0;

  init();

  function init() {
    injectStyles();
    chrome.storage.sync.get(DEFAULTS, s => {
      settings = { ...DEFAULTS, ...s };
      settings.concurrencyLimit = clamp(settings.concurrencyLimit, 1, 8);
      applyStyles();
      watchVideo();
      watchTranscript();
    });
    chrome.storage.onChanged.addListener((c, a) => {
      if (a !== 'sync') return;
      for (const [k, v] of Object.entries(c)) if (k in settings) settings[k] = v.newValue;
      settings.concurrencyLimit = clamp(settings.concurrencyLimit, 1, 8);
      applyStyles();
      if ('translateTranscript' in c) watchTranscript();
    });
  }

  function applyStyles() {
    document.documentElement.style.setProperty('--caption-font-size', settings.captionFontSize);
    document.documentElement.style.setProperty('--caption-color', settings.captionColor);
  }

  function watchVideo() {
    const check = () => {
      const v = document.querySelector('video');
      if (v !== video) {
        video = v;
        if (video) {
          video.addEventListener('loadeddata', pollTrack);
          setInterval(pollTrack, 1500);
        }
      }
    };
    check();
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  }

  function pollTrack() {
    if (!video) return;
    const tracks = Array.from(video.textTracks || []);
    const t = tracks.find(x => x.kind === 'captions' || x.kind === 'subtitles');
    if (t && t !== track) attachTrack(t);
    if (!t && track) detachTrack();
  }

  function attachTrack(t) {
    detachTrack();
    track = t;
    track.mode = 'hidden';
    track.addEventListener('cuechange', onCue);
    onCue();
  }

  function detachTrack() {
    if (track) track.removeEventListener('cuechange', onCue);
    track = null;
    clearOverlay();
  }

  function onCue() {
    if (!track) return;
    const cues = Array.from(track.activeCues || []);
    const text = cues.map(c => c.text || c.lines?.join(' ') || '').join(' ').replace(/\s+/g, ' ').trim();
    if (!text) return clearOverlay();
    ensureOverlay();
    overlayOrig.textContent = text;
    overlay.style.display = 'flex';
    translateCaption(text);
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return;
    overlay = document.createElement('div');
    overlay.id = 'udemy-translator-overlay';
    overlay.innerHTML = '<div class="orig"></div><div class="trans"></div>';
    overlayOrig = overlay.querySelector('.orig');
    overlayTrans = overlay.querySelector('.trans');
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }

  function clearOverlay() {
    if (overlayOrig) overlayOrig.textContent = '';
    if (overlayTrans) overlayTrans.textContent = '';
    if (overlay) overlay.style.display = 'none';
  }

  function translateCaption(text) {
    if (captionEl?.dataset.orig === text) return;
    captionEl = overlay;
    captionEl.dataset.orig = text;

    const cached = mem.get(text);
    if (cached) {
      overlayTrans.textContent = cached;
      overlayTrans.style.display = 'block';
      return;
    }

    const id = ++requestId;
    const ctx = history.slice(-2);
    history.push(text);

    sendTranslate(text, ctx)
      .then(r => {
        if (id !== requestId || !r.success) return;
        mem.set(text, r.translatedText);
        overlayTrans.textContent = r.translatedText;
        overlayTrans.style.display = 'block';
      })
      .catch(e => {
        if (e.message === 'MISSING_API_KEY') showError('请先配置 API Key');
      });
  }

  function watchTranscript() {
    if (!settings.translateTranscript) {
      document.querySelectorAll('.trans-transcript').forEach(el => el.remove());
      return;
    }
    const process = el => {
      const text = el.textContent?.trim();
      if (!text || el.dataset.orig === text) return;
      el.dataset.orig = text;
      const cached = mem.get(text);
      if (cached) return showTranscriptTrans(el, cached);

      const ctx = history.slice(-2);
      transQueue.push({ el, text, ctx });
      pumpTransQueue();
    };
    document.querySelectorAll(TRANSCRIPT_SELECTOR).forEach(process);
    new MutationObserver(m => {
      for (const n of m.flatMap(x => Array.from(x.addedNodes))) {
        if (n.matches?.(TRANSCRIPT_SELECTOR)) process(n);
        n.querySelectorAll?.(TRANSCRIPT_SELECTOR)?.forEach(process);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  function pumpTransQueue() {
    while (transActive < settings.concurrencyLimit && transQueue.length) {
      transActive++;
      const { el, text, ctx } = transQueue.shift();
      sendTranslate(text, ctx)
        .then(r => {
          if (r.success && el.dataset.orig === text) {
            mem.set(text, r.translatedText);
            showTranscriptTrans(el, r.translatedText);
          }
        })
        .catch(() => {})
        .finally(() => { transActive--; pumpTransQueue(); });
    }
  }

  function showTranscriptTrans(el, text) {
    let t = el.parentElement.querySelector('.trans-transcript');
    if (!t) {
      t = document.createElement('div');
      t.className = 'trans-transcript';
      el.parentElement.appendChild(t);
    }
    t.textContent = text;
    t.style.display = 'block';
  }

  function sendTranslate(text, ctx) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'translate', text, context: ctx }, r => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!r) reject(new Error('NO_RESPONSE'));
        else if (!r.success) reject(new Error(r.error));
        else resolve(r);
      });
    });
  }

  function showError(msg) {
    let el = document.getElementById('udemy-translator-error');
    if (!el) {
      el = document.createElement('div');
      el.id = 'udemy-translator-error';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => el.style.display = 'none', 5000);
  }

  function clamp(v, min, max) {
    const n = Math.round(Number(v) || min);
    return Math.min(Math.max(n, min), max);
  }

  function injectStyles() {
    if (document.getElementById('udemy-translator-style')) return;
    const style = document.createElement('style');
    style.id = 'udemy-translator-style';
    style.textContent = `
      :root { --caption-font-size: 2.4rem; --caption-color: #b5e3ff; }
      #udemy-translator-error {
        position: fixed; top: 20px; right: 20px; z-index: 99999;
        background: #ff4757; color: #fff; padding: 12px 16px; border-radius: 8px;
        font-size: 14px; font-weight: 500; display: none;
      }
      #udemy-translator-overlay {
        position: fixed; left: 50%; bottom: 12%; transform: translateX(-50%);
        z-index: 9999; pointer-events: none; text-align: center;
        display: flex; flex-direction: column; gap: 0.35em;
        max-width: min(80vw, 960px); padding: 0.35em 0.75em;
        text-shadow: 0 0 12px rgba(0,0,0,0.8);
      }
      #udemy-translator-overlay .orig { color: #fff; font-size: calc(var(--caption-font-size) * 0.6); }
      #udemy-translator-overlay .trans {
        font-size: var(--caption-font-size); color: var(--caption-color);
        font-weight: 500; display: none;
      }
      .trans-transcript {
        font-size: 0.85em; color: #2d7a2d; margin-top: 0.2em; display: none;
      }
    `;
    document.head.appendChild(style);
  }
})();