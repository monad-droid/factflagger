// FactFlag content script (isolated world).
// Phase 1: for each watch-page video, get the transcript and print it to the console.
(() => {
  const FROM_CS = 'factflag-cs';
  const FROM_PAGE = 'factflag-page';
  const LOG = '[FactFlag]';
  const Overlay = self.FactFlagOverlay;

  let runToken = 0;       // bumps on each new video so stale work is ignored
  let currentVideoId = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getSettings() {
    const stored = await chrome.storage.local.get(Object.keys(self.FACTFLAG_DEFAULTS));
    return { ...self.FACTFLAG_DEFAULTS, ...stored };
  }

  function videoIdFromUrl() {
    if (location.pathname !== '/watch') return null;
    return new URLSearchParams(location.search).get('v');
  }

  function fmtTime(sec) {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  // ---- Primary method: ask the page bridge (MAIN world) for the caption track ----
  function requestCaptionsFromPage(videoId) {
    const reqId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        window.removeEventListener('message', onMsg);
        resolve({ ok: false, reason: 'failed', error: 'page bridge timed out' });
      }, 60000);
      function onMsg(event) {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== FROM_PAGE || msg.type !== 'CAPTIONS_RESULT' || msg.reqId !== reqId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMsg);
        resolve(msg.result);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ source: FROM_CS, type: 'GET_CAPTIONS', reqId, videoId }, location.origin);
    });
  }

  // ---- Fallback method: open YouTube's "Show transcript" panel and read it ----
  // YouTube has renamed these elements several times, so we try old and new names.
  const PANEL_SEL = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript" i]';
  const SEGMENT_SEL = 'transcript-segment-view-model, ytd-transcript-segment-renderer';

  function parseTimestamp(str) {
    const m = (str || '').trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return m[3] !== undefined
      ? +m[1] * 3600 + +m[2] * 60 + +m[3]
      : +m[1] * 60 + +m[2];
  }

  function findSegmentEls() {
    const inPanels = [...document.querySelectorAll(PANEL_SEL)]
      .flatMap((p) => [...p.querySelectorAll(SEGMENT_SEL)]);
    return inPanels.length ? inPanels : [...document.querySelectorAll('ytd-transcript-segment-renderer')];
  }

  function findTranscriptButton() {
    const direct = document.querySelector('ytd-video-description-transcript-section-renderer button');
    if (direct) return direct;
    return [...document.querySelectorAll('button, ytd-button-renderer, yt-button-shape button')]
      .find((b) => /show transcript/i.test(b.getAttribute('aria-label') || b.textContent || ''));
  }

  function readSegment(el) {
    const tsEl = el.querySelector(
      '.segment-timestamp, [class*="Timestamp"]:not([class*="A11y"]):not([class*="a11y"])'
    );
    const textEl = el.querySelector('.segment-text, .ytAttributedStringHost, [class*="SegmentText"]');
    let ts = tsEl?.textContent?.trim();
    let text = textEl?.textContent?.trim();
    if (!ts || !text) {
      // Last resort: first line that looks like a timestamp, the rest is text.
      const parts = (el.innerText || el.textContent || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const i = parts.findIndex((p) => parseTimestamp(p) !== null);
      if (i === -1) return null;
      ts = ts || parts[i];
      text = text || parts.filter((_, j) => j !== i).join(' ');
    }
    const start = parseTimestamp(ts);
    if (start === null || !text) return null;
    return { start, text: text.replace(/\s+/g, ' ') };
  }

  function scrollableAncestor(el) {
    for (let n = el?.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }

  async function scrapeTranscriptPanel(token) {
    let openedByUs = false;
    if (!findSegmentEls().length) {
      // The button lives in the description; expanding it first makes it render reliably.
      document.querySelector('ytd-text-inline-expander #expand, #description-inline-expander #expand')?.click();
      await sleep(500);
      const btn = findTranscriptButton();
      if (!btn) return { ok: false, error: 'no "Show transcript" button found' };
      btn.click();
      openedByUs = true;
    }

    // Wait for segments to appear.
    for (let i = 0; i < 40 && !findSegmentEls().length; i++) {
      if (token !== runToken) return { ok: false, error: 'cancelled' };
      await sleep(250);
    }
    if (!findSegmentEls().length) return { ok: false, error: 'transcript panel had no segments' };

    // Long transcripts load lazily as you scroll; scroll until the count stops growing.
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) {
      const els = findSegmentEls();
      if (els.length === last) stable++; else stable = 0;
      last = els.length;
      const scroller = scrollableAncestor(els[els.length - 1]);
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      await sleep(300);
    }

    const raw = findSegmentEls().map(readSegment).filter(Boolean);
    const segments = raw.map((s, i) => ({
      start: s.start,
      dur: i + 1 < raw.length ? Math.max(0, raw[i + 1].start - s.start) : 5,
      text: s.text
    }));

    if (openedByUs) {
      const panel = document.querySelector(PANEL_SEL);
      panel?.querySelector('#visibility-button button, button[aria-label*="close" i]')?.click();
    }
    return segments.length
      ? { ok: true, method: 'transcript-panel', segments }
      : { ok: false, error: 'could not read transcript segments' };
  }

  // ---- Main flow ----
  async function handleVideo(videoId) {
    const token = ++runToken;
    Overlay.clear();
    const settings = await getSettings();
    if (!settings.enabled) {
      console.info(LOG, 'FactFlag is turned off in settings.');
      return;
    }
    console.info(LOG, `Getting captions for video ${videoId}…`);
    Overlay.setStatus('Getting captions…');

    let result = await requestCaptionsFromPage(videoId);
    if (token !== runToken) return;

    if (!result.ok && result.reason === 'live') {
      console.warn(LOG, 'This is a live stream — not supported in v1.');
      Overlay.setStatus('Live streams aren’t supported');
      return;
    }
    if (!result.ok && result.reason === 'no_captions') {
      console.warn(LOG, 'No captions available');
      Overlay.setStatus('No captions available');
      return;
    }
    if (!result.ok) {
      console.warn(LOG, `Primary caption method failed (${result.error}). Trying the transcript panel…`);
      const fallback = await scrapeTranscriptPanel(token);
      if (token !== runToken) return;
      if (!fallback.ok) {
        console.error(LOG, `Transcript panel fallback also failed (${fallback.error}).`);
        console.warn(LOG, 'No captions available');
        Overlay.setStatus('No captions available');
        return;
      }
      result = { ...fallback, track: result.track };
    }

    const t = result.track;
    const trackDesc = t ? `${t.name} [${t.languageCode}${t.autoGenerated ? ', auto-generated' : ''}]` : 'unknown track';
    const lines = result.segments.map((s) => `[${fmtTime(s.start)}] ${s.text}`);
    console.groupCollapsed(
      `${LOG} Transcript for ${videoId}: ${result.segments.length} lines via ${result.method} — ${trackDesc}`
    );
    console.log(lines.join('\n'));
    console.groupEnd();
    console.log(LOG, 'Raw segments:', result.segments);

    Overlay.setStatus('Finding claims…');
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT',
      videoId,
      title: t?.videoTitle || document.title.replace(/ - YouTube$/, ''),
      channel: t?.channel || '',
      playhead: document.querySelector('#movie_player video')?.currentTime || 0,
      segments: result.segments
    }).catch(() => {});
  }

  // ---- Updates from the background worker ----
  function statusFromState(state) {
    const n = state.claims.length;
    const found = `${n} claim${n === 1 ? '' : 's'} found`;
    if (state.status === 'error') return `Error: ${state.error}`;
    if (state.status === 'done') return `Scan complete · ${found}`;
    const progress = `Finding claims… ${state.chunksDone}/${state.chunksTotal} sections · ${found}`;
    return state.note ? `${progress} · ${state.note}` : progress;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'STATE' || msg.state?.videoId !== currentVideoId) return;
    Overlay.setStatus(statusFromState(msg.state));
    Overlay.setClaims(msg.state.claims);
  });

  function onNavigate() {
    const videoId = videoIdFromUrl();
    if (videoId === currentVideoId) return;
    if (currentVideoId) chrome.runtime.sendMessage({ type: 'LEFT_VIDEO' }).catch(() => {});
    currentVideoId = videoId;
    if (!videoId) { runToken++; Overlay.clear(); return; }
    handleVideo(videoId);
  }

  // YouTube switches videos without reloading the page; it fires this event when done.
  document.addEventListener('yt-navigate-finish', onNavigate);
  onNavigate();
})();
