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

  // ---- Fallback method: read YouTube's transcript panel ----
  // YouTube renames its transcript elements often (in 2026 the transcript moved
  // into an "In this video" panel with Chapters / Transcript tabs), so instead of
  // relying on element names we find rows that start with a timestamp like
  // "0:39" and read the text beside it.
  const TS_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
  // Places that show timestamps but are NOT the transcript.
  const NOT_TRANSCRIPT = '#movie_player, #comments, ytd-comments, #description, ytd-text-inline-expander, ' +
    'ytd-macro-markers-list-item-renderer, [class*="factflag"]';
  const PANEL_SEL = 'ytd-engagement-panel-section-list-renderer';

  function parseTimestamp(str) {
    const m = (str || '').trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (!m) return null;
    return m[3] !== undefined
      ? +m[1] * 3600 + +m[2] * 60 + +m[3]
      : +m[1] * 60 + +m[2];
  }

  // A screen-reader label next to the timestamp, e.g. "39 seconds" or "1 minute, 5 seconds".
  const DURATION_LABEL = /^(\d+\s+(hours?|minutes?|seconds?),?\s*)+$/i;

  // The spoken text of a row: every text piece except the timestamp itself and a
  // duration label that comes before the speech. (Removing "N seconds" anywhere
  // would also delete real words like "at 30 seconds".)
  function rowText(row, leaf) {
    const parts = [];
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (leaf.contains(node)) continue;
      const piece = node.textContent.replace(/\s+/g, ' ').trim();
      if (!piece) continue;
      if (!parts.length && DURATION_LABEL.test(piece)) continue;
      parts.push(piece);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // Returns [{ el, start, text }] for every visible transcript row on the page.
  function findTranscriptRows() {
    const leaves = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.children.length || !TS_RE.test((el.textContent || '').trim())) continue;
      if (el.closest('a') || el.closest(NOT_TRANSCRIPT) || !el.getClientRects().length) continue;
      leaves.push(el);
    }
    // For each timestamp, its row is the largest ancestor holding no other timestamp.
    const count = new Map();
    for (const leaf of leaves) {
      for (let n = leaf.parentElement; n && n !== document.body; n = n.parentElement) {
        count.set(n, (count.get(n) || 0) + 1);
      }
    }
    const rows = [];
    for (const leaf of leaves) {
      let row = leaf;
      while (row.parentElement && row.parentElement !== document.body && count.get(row.parentElement) === 1) {
        row = row.parentElement;
      }
      const ts = leaf.textContent.trim();
      const text = rowText(row, leaf);
      const start = parseTimestamp(ts);
      if (start !== null && text) rows.push({ el: row, start, text });
    }
    return rows;
  }

  function transcriptButtons() {
    const label = (el) => (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
    const clickable = [...document.querySelectorAll(
      'button, [role="tab"], tp-yt-paper-tab, chip-view-model, yt-chip-cloud-chip-renderer'
    )].filter((el) => !el.closest('#movie_player'));
    const found = [
      document.querySelector('ytd-video-description-transcript-section-renderer button'),
      ...clickable.filter((el) => /^(show )?transcript$/i.test(label(el))),
      ...clickable.filter((el) => /show transcript/i.test(label(el)))
    ].filter(Boolean);
    return [...new Set(found)];
  }

  // The transcript list's own scroll box. Never the page itself or anything
  // that contains the video — scrolling those would move the whole page.
  function scrollableAncestor(el) {
    const playerEl = document.getElementById('movie_player');
    for (let n = el?.parentElement; n; n = n.parentElement) {
      if (n === document.body || n === document.documentElement || n === document.scrollingElement) return null;
      if (playerEl && n.contains(playerEl)) return null;
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  }

  async function waitForRows(token, ms) {
    for (let waited = 0; waited < ms; waited += 250) {
      if (token !== runToken) return null;
      const rows = findTranscriptRows();
      if (rows.length >= 3) return rows;
      await sleep(250);
    }
    return null;
  }

  function logTranscriptDiagnostics() {
    const panels = [...document.querySelectorAll(PANEL_SEL)].map((p) => p.getAttribute('target-id'));
    const leaves = [...document.querySelectorAll('body *')]
      .filter((el) => !el.children.length && TS_RE.test((el.textContent || '').trim())).length;
    console.warn(LOG, 'Transcript panel diagnostics (please screenshot this for debugging):', {
      engagementPanels: panels,
      transcriptButtons: transcriptButtons().map((b) => `${b.tagName.toLowerCase()}: ${(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 40)}`),
      timestampLikeElements: leaves,
      transcriptRowsFound: findTranscriptRows().length
    });
  }

  // Opening the panel clicks buttons further down the page, which makes the
  // browser scroll to them. Put the page back where the viewer had it.
  async function scrapeTranscriptPanel(token) {
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const restoreScroll = () => {
      if (window.scrollX !== scrollX || window.scrollY !== scrollY) window.scrollTo(scrollX, scrollY);
    };
    // While we work (and for 5 s after), undo any page scroll the viewer didn't
    // make themselves — YouTube can move the page well after a click.
    // Only real scrolling input counts: clicks and Space (play/pause on
    // YouTube) used to switch the guard off, letting the page jump.
    let userScrolled = false;
    const onUserInput = (e) => {
      if (e.type !== 'keydown' || ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
        if (e.type === 'keydown' && e.target?.closest?.('#movie_player')) return;
        userScrolled = true;
      }
    };
    let pageMoves = 0;
    const onScroll = () => {
      if (userScrolled || (window.scrollX === scrollX && window.scrollY === scrollY)) return;
      pageMoves++;
      restoreScroll();
    };
    const inputEvents = ['wheel', 'touchmove', 'keydown'];
    for (const ev of inputEvents) window.addEventListener(ev, onUserInput, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    // Scroll events can be delayed (e.g. in background tabs), so also check often.
    const poll = setInterval(onScroll, 100);
    const stopGuard = () => {
      clearInterval(poll);
      window.removeEventListener('scroll', onScroll);
      for (const ev of inputEvents) window.removeEventListener(ev, onUserInput, { capture: true });
    };

    // Keep any panel we open off-screen and out of the page layout while we
    // read it, so the sidebar doesn't shift and YouTube's "follow along"
    // scrolling in the transcript can't drag the page. Panels the viewer
    // already had open are left alone.
    for (const panel of document.querySelectorAll(PANEL_SEL)) {
      if (/EXPANDED/.test(panel.getAttribute('visibility') || '')) panel.setAttribute('data-factflag-keep', '');
    }
    const hideStyle = document.createElement('style');
    hideStyle.textContent = `${PANEL_SEL}[visibility*="EXPANDED"]:not([data-factflag-keep]) {
      position: fixed !important; left: -10000px !important; top: 0 !important;
      width: 400px !important; height: 600px !important; }`;
    document.documentElement.appendChild(hideStyle);

    let expandedDescription = false;
    try {
      return await readTranscriptPanel(token, restoreScroll, () => { expandedDescription = true; });
    } finally {
      if (expandedDescription) {
        document.querySelector('ytd-text-inline-expander #collapse, #description-inline-expander #collapse')?.click();
      }
      if (!userScrolled) restoreScroll();
      // Unhide once the panel has had time to close.
      setTimeout(() => {
        hideStyle.remove();
        for (const panel of document.querySelectorAll('[data-factflag-keep]')) panel.removeAttribute('data-factflag-keep');
      }, 1500);
      setTimeout(() => {
        stopGuard();
        if (pageMoves) console.info(LOG, `Transcript reading: undid ${pageMoves} page move(s) YouTube made.`);
        if (userScrolled) console.info(LOG, 'Transcript reading: you scrolled, so the page was left where you put it.');
      }, 5000);
    }
  }

  // Close the panel we opened, and check it really closed — a panel left open
  // keeps following the video and can move the page.
  async function closePanel(panel) {
    if (!panel) {
      console.warn(LOG, 'Transcript panel: couldn\'t find the panel to close it.');
      return;
    }
    const isOpen = () => {
      const v = panel.getAttribute('visibility');
      return v ? /EXPANDED/.test(v) : !!panel.getClientRects().length;
    };
    const buttons = [...panel.querySelectorAll('#visibility-button button, button[aria-label*="close" i], [aria-label*="close" i]')];
    for (const b of buttons) {
      b.click();
      await sleep(300);
      if (!isOpen()) return;
    }
    // Last resort: tell YouTube's panel to hide itself.
    panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
    await sleep(300);
    if (isOpen()) console.warn(LOG, `Transcript panel didn't close (target-id: ${panel.getAttribute('target-id')}).`);
  }

  async function readTranscriptPanel(token, restoreScroll, onExpanded) {
    let openedByUs = false;
    let rows = findTranscriptRows();
    if (rows.length < 3) {
      // The transcript button lives in the expanded description; the Transcript
      // tab lives in the "In this video" panel. Try each candidate in turn.
      const expand = document.querySelector('ytd-text-inline-expander #expand, #description-inline-expander #expand');
      if (expand && expand.getClientRects().length) {
        expand.click();
        onExpanded();
      }
      restoreScroll();
      await sleep(500);
      for (const btn of transcriptButtons()) {
        btn.focus?.({ preventScroll: true });
        btn.click();
        restoreScroll();
        openedByUs = true;
        rows = await waitForRows(token, 3000);
        if (token !== runToken) return { ok: false, error: 'cancelled' };
        if (rows) break;
      }
    }
    if (!rows || rows.length < 3) {
      logTranscriptDiagnostics();
      return { ok: false, error: 'could not find the transcript panel' };
    }

    // Long transcripts load lazily (and may drop rows that scroll out of view),
    // so collect rows while scrolling until no new ones appear.
    const collected = new Map();
    const add = (list) => list.forEach((r) => collected.set(`${r.start}|${r.text}`, r));
    add(rows);
    // Scroll down a bit at a time, waiting for the list to redraw after each
    // step. Some lists only keep the visible rows on the page, so jumping too
    // far (or reading before it redraws) would silently skip rows.
    const scroller = scrollableAncestor(rows[rows.length - 1].el);
    // If every row is already on the page (rows reach from the top of the list
    // to the bottom), there's nothing to scroll for — just check once whether
    // more rows load when scrolled to the bottom.
    const fullyRendered = () => {
      if (!scroller) return true;
      const box = scroller.getBoundingClientRect();
      const all = findTranscriptRows();
      const first = all[0]?.el.getBoundingClientRect();
      const last = all[all.length - 1]?.el.getBoundingClientRect();
      if (!first || !last) return true;
      const rowH = Math.max(10, last.height);
      const topOk = first.top - (box.top - scroller.scrollTop) <= rowH * 2;
      const bottomOk = (box.top - scroller.scrollTop + scroller.scrollHeight) - last.bottom <= rowH * 3;
      return topOk && bottomOk;
    };
    if (scroller && fullyRendered()) {
      for (let i = 0; i < 50; i++) {
        const before = collected.size;
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(800);
        add(findTranscriptRows());
        if (collected.size === before) break;
      }
    } else if (scroller) {
      const keysOf = (list) => new Set(list.map((r) => `${r.start}|${r.text}`));
      scroller.scrollTop = 0;
      await sleep(300);
      let previous = findTranscriptRows();
      add(previous);
      let stableAtBottom = 0;
      for (let i = 0; i < 2000 && stableAtBottom < 3; i++) {
        if (token !== runToken) return { ok: false, error: 'cancelled' };
        const step = Math.max(40, scroller.clientHeight * 0.5);
        const prevKeys = keysOf(previous);
        const topBefore = scroller.scrollTop;
        scroller.scrollTop = topBefore + step;
        // Wait (up to ~1.5s) for rows that weren't there before.
        let current = previous;
        for (let w = 0; w < 15; w++) {
          await sleep(100);
          current = findTranscriptRows();
          if (current.some((r) => !prevKeys.has(`${r.start}|${r.text}`))) break;
        }
        const overlaps = current.some((r) => prevKeys.has(`${r.start}|${r.text}`));
        if (!overlaps && current.length && previous.length && step > 41) {
          // The list jumped past rows we never saw — go back half a step.
          scroller.scrollTop = topBefore + step / 4;
          await sleep(300);
          current = findTranscriptRows();
        }
        const before = collected.size;
        add(current);
        previous = current;
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        stableAtBottom = atBottom && collected.size === before ? stableAtBottom + 1 : 0;
      }
    }

    const raw = [...collected.values()].sort((a, b) => a.start - b.start);
    const segments = raw.map((s, i) => ({
      start: s.start,
      dur: i + 1 < raw.length ? Math.max(0, raw[i + 1].start - s.start) : 5,
      text: s.text
    }));

    if (openedByUs) await closePanel(rows[0].el.closest(PANEL_SEL));
    return { ok: true, method: 'transcript-panel', segments };
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
    if (!result.ok) {
      // The player's caption list can be empty even when YouTube shows a
      // transcript, so always try the transcript panel before giving up.
      console.warn(LOG, result.reason === 'no_captions'
        ? 'The player lists no caption tracks. Trying the transcript panel…'
        : `Primary caption method failed (${result.error}). Trying the transcript panel…`);
      const fallback = await scrapeTranscriptPanel(token);
      if (token !== runToken) return;
      if (!fallback.ok) {
        console.error(LOG, `Transcript panel fallback also failed (${fallback.error}).`);
        console.warn(LOG, 'No captions available');
        Overlay.setStatus('No captions available');
        return;
      }
      result = { ...fallback, track: result.track, meta: result.meta };
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

    Overlay.setStatus('Checking ahead…');
    chrome.runtime.sendMessage({
      type: 'TRANSCRIPT',
      videoId,
      title: result.meta?.videoTitle || t?.videoTitle || document.title.replace(/ - YouTube$/, ''),
      channel: result.meta?.channel || t?.channel || '',
      published: result.meta?.published || t?.published || '',
      playhead: document.querySelector('#movie_player video')?.currentTime || 0,
      rate: document.querySelector('#movie_player video')?.playbackRate || 1,
      segments: result.segments
    }).catch(() => {});
  }

  // ---- Updates from the background worker ----
  function statusFromState(state) {
    const resolved = state.claims.filter((c) => ['done', 'error', 'skipped'].includes(c.status)).length;
    const searched = state.claims.filter((c) => c.status === 'done' || c.status === 'error').length;
    const falseCount = state.claims.filter((c) => c.verdict === 'FALSE').length;
    const found = state.claims.length;
    let counts = resolved
      ? `${resolved} claim${resolved === 1 ? '' : 's'} checked · ${searched} searched · ${falseCount} false`
      : found ? `${found} claim${found === 1 ? '' : 's'} found, checking…` : 'no checkable claims yet';
    if (state.sectionsFailed) {
      counts += ` · ${state.sectionsFailed} section${state.sectionsFailed === 1 ? '' : 's'} failed: ${state.lastSectionError}`;
    }
    if (state.status === 'error') return `${state.error} · ${counts}`;
    if (state.status === 'done') return `Done · ${counts}`;
    if (state.status === 'idle') return `Up to date · ${counts}`;
    const progress = `Checking ahead… ${counts}`;
    return state.note ? `${progress} · ${state.note}` : progress;
  }

  // Tell the background where the viewer is listening, so it checks only the
  // next couple of minutes. Nothing is sent while paused, so no work happens.
  function sendPlayhead() {
    const v = document.querySelector('#movie_player video');
    if (!currentVideoId || !v) return;
    try {
      chrome.runtime.sendMessage({
        type: 'PLAYHEAD', videoId: currentVideoId, time: v.currentTime, rate: v.playbackRate || 1
      }).catch(() => {});
    } catch (_) { /* extension was reloaded; this page's script is orphaned */ }
  }
  for (const ev of ['seeked', 'play', 'ratechange']) document.addEventListener(ev, sendPlayhead, true);
  setInterval(() => {
    const v = document.querySelector('#movie_player video');
    if (v && !v.paused) sendPlayhead();
  }, 5000);

  // Leaving YouTube (or reloading) in this tab stops the work for this video.
  window.addEventListener('pagehide', () => {
    if (!currentVideoId) return;
    try { chrome.runtime.sendMessage({ type: 'LEFT_VIDEO' }).catch(() => {}); } catch (_) {}
  });

  // Print each verdict in the console as it arrives (only FALSE shows on the video).
  const loggedVerdicts = new Set();
  function logNewVerdicts(state) {
    for (const c of state.claims) {
      const key = `${state.videoId}:${c.id}`;
      if (loggedVerdicts.has(key) || !['done', 'error', 'skipped'].includes(c.status)) continue;
      loggedVerdicts.add(key);
      const label = c.status === 'skipped' ? `NOT SEARCHED (judged likely true: ${c.triageReason || 'no reason'})`
        : c.status === 'error' ? `ERROR (${c.error})` : c.verdict;
      console.info(LOG, `${fmtTime(c.t)} ${label}\n  Claim: ${c.claim}\n  Speaker: "${c.quote}"` +
        (c.explanation ? `\n  Why: ${c.explanation}` : '') +
        (c.evidenceQuote ? `\n  Source says: "${c.evidenceQuote}"` : '') +
        (c.sourceUrl ? `\n  Source: ${c.sourceUrl}` : ''));
    }
  }

  // ---- Optional sound with each alert (setting can change at any time) ----
  let soundOn = self.FACTFLAG_DEFAULTS.soundEnabled;
  chrome.storage.local.get('soundEnabled').then((s) => {
    if (typeof s.soundEnabled === 'boolean') soundOn = s.soundEnabled;
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.soundEnabled) soundOn = !!changes.soundEnabled.newValue;
  });

  function alertFalseClaim(c) {
    Overlay.alert(c);
    if (soundOn && self.factflagDing()) console.info(LOG, `ding — FALSE claim at ${fmtTime(c.t)}`);
  }

  // ---- Alert (claims list opens on it, plus the ding) when playback reaches a FALSE claim ----
  const LATE_ALERT_SECONDS = 15; // verdict arrived just after the claim was said
  // When the alert comes (start or end of the claim) is set in settings.
  const alertAt = (c) => Overlay.alertMoment(c);
  let falseClaims = [];
  const alerted = new Set();     // claim ids alerted during this viewing
  const knownFalse = new Set();  // claim ids already known to be FALSE
  let lastTime = null;
  let playedFrom = null;         // where the current stretch of normal playback began

  function playerVideo() {
    return document.querySelector('#movie_player video');
  }
  function adPlaying() {
    return !!document.querySelector('#movie_player.ad-showing');
  }

  function checkAlerts() {
    const v = playerVideo();
    if (!v || !currentVideoId || adPlaying()) { lastTime = null; return; }
    const now = v.currentTime;
    const prev = lastTime;
    lastTime = now;
    if (prev === null) { playedFrom = now; return; }
    // Seeking backwards: allow claims ahead of the new position to alert again.
    if (now < prev - 1) {
      for (const c of falseClaims) if (alertAt(c) > now) alerted.delete(c.id);
      playedFrom = now;
      return;
    }
    // Only normal playback counts — skipping past a claim doesn't trigger it.
    if (now - prev > 3) { playedFrom = now; return; }
    for (const c of falseClaims) {
      if (!alerted.has(c.id) && alertAt(c) > prev && alertAt(c) <= now) {
        alerted.add(c.id);
        alertFalseClaim(c);
      }
    }
  }
  // timeupdate doesn't bubble, so listen in the capture phase.
  document.addEventListener('timeupdate', checkAlerts, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'STATE' || msg.state?.videoId !== currentVideoId) return;
    Overlay.setStatus(statusFromState(msg.state));
    if (msg.state.status === 'error' && msg.state.limitHit) {
      const resetAt = msg.state.limitResetAt;
      let when = '';
      if (resetAt && resetAt > Date.now()) {
        const mins = Math.ceil((resetAt - Date.now()) / 60000);
        when = ` Resets in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}.`;
      }
      Overlay.showBanner(`Usage limit reached — FactFlag has stopped checking.${when}`, msg.state.error);
    } else {
      Overlay.hideBanner();
    }
    // Only FALSE claims are shown on the video.
    falseClaims = msg.state.claims.filter((c) => c.verdict === 'FALSE');
    Overlay.setClaims(falseClaims);
    Overlay.setAllClaims(msg.state.claims);
    logNewVerdicts(msg.state);
    // A verdict that arrives a few seconds after the claim was said still alerts
    // (only verdicts that just arrived — not old ones, e.g. after skipping ahead).
    const justArrived = falseClaims.filter((c) => !knownFalse.has(c.id));
    for (const c of falseClaims) knownFalse.add(c.id);
    const v = playerVideo();
    if (v && !v.paused && !adPlaying()) {
      for (const c of justArrived) {
        const heard = playedFrom !== null && c.t >= playedFrom; // played through it since the last skip
        if (heard && !alerted.has(c.id) && v.currentTime >= alertAt(c) &&
            v.currentTime - alertAt(c) <= LATE_ALERT_SECONDS) {
          alerted.add(c.id);
          alertFalseClaim(c);
        }
      }
    }
  });

  function onNavigate() {
    const videoId = videoIdFromUrl();
    if (videoId === currentVideoId) return;
    if (currentVideoId) chrome.runtime.sendMessage({ type: 'LEFT_VIDEO' }).catch(() => {});
    currentVideoId = videoId;
    falseClaims = [];
    alerted.clear();
    knownFalse.clear();
    playedFrom = null;
    lastTime = null;
    if (!videoId) { runToken++; Overlay.clear(); return; }
    handleVideo(videoId);
  }

  // YouTube switches videos without reloading the page; it fires this event when done.
  document.addEventListener('yt-navigate-finish', onNavigate);
  onNavigate();
})();
