// FactFlag on-video UI: a status label on the player, triangles on the progress
// bar at each FALSE claim, a hover card on each triangle, and the claims list
// (which also opens by itself, with a ding, when a FALSE claim is said).
self.FactFlagOverlay = (() => {
  let claims = [];
  let statusText = '';
  let statusEl = null;
  let layerEl = null;
  let tipEl = null;
  let renderedKey = '';

  const player = () => document.getElementById('movie_player');
  const video = () => document.querySelector('#movie_player video');
  const progressBar = () => document.querySelector('#movie_player .ytp-progress-bar');

  function fmtTime(sec) {
    const s = Math.floor(sec);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  }

  function renderStatus() {
    const p = player();
    if (!p) return;
    if (!statusEl || !p.contains(statusEl)) {
      statusEl = document.createElement('div');
      statusEl.className = 'factflag-status';
      statusEl.title = 'Click to see every claim FactFlag has checked';
      stopPlayerEvents(statusEl);
      statusEl.addEventListener('click', toggleList);
      p.appendChild(statusEl);
    }
    statusEl.textContent = statusText ? `FactFlag · ${statusText} ${listOpen ? '▴' : '▾'}` : '';
    statusEl.classList.toggle('open', listOpen);
  }

  // Keep clicks on our panels from reaching the player (which would pause/play).
  function stopPlayerEvents(el) {
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      el.addEventListener(ev, (e) => e.stopPropagation());
    }
  }

  // ---- List of every checked claim (opened by clicking the status line) ----
  let allClaims = [];
  let listOpen = false;
  // The list fills in live: a claim appears once the speaker finishes saying
  // it, like the alert card. Ids already shown, so new rows can be highlighted.
  let shownIds = new Set();
  // Claims shown even before playback reaches them (a clicked triangle).
  const revealed = new Set();
  // A FALSE claim that should flash once on the next render.
  let flashId = null;
  let shownKey = '';
  let liveList = self.FACTFLAG_DEFAULTS.liveList;
  let autoOpenList = self.FACTFLAG_DEFAULTS.autoOpenList;
  let glowMode = self.FACTFLAG_DEFAULTS.glowMode;
  let alertTiming = self.FACTFLAG_DEFAULTS.alertTiming;
  let glowStrength = self.FACTFLAG_DEFAULTS.glowStrength;
  // Which verdicts glow, e.g. { false: true, true: false, ... }.
  const GLOW_KEYS = { false: 'glowFalse', misleading: 'glowMisleading', true: 'glowTrue', unverifiable: 'glowUnverifiable' };
  // Which verdicts still pop up (with words) in glow mode.
  const POP_KEYS = { false: 'glowPopFalse', misleading: 'glowPopMisleading', true: 'glowPopTrue', unverifiable: 'glowPopUnverifiable' };
  const glowOn = {};
  const popOn = {};
  for (const [kind, key] of Object.entries(GLOW_KEYS)) glowOn[kind] = self.FACTFLAG_DEFAULTS[key];
  for (const [kind, key] of Object.entries(POP_KEYS)) popOn[kind] = self.FACTFLAG_DEFAULTS[key];
  chrome.storage.local.get(['liveList', 'autoOpenList', 'glowMode', 'alertTiming', 'glowStrength', ...Object.values(GLOW_KEYS), ...Object.values(POP_KEYS)]).then((s) => {
    for (const [kind, key] of Object.entries(POP_KEYS)) if (typeof s[key] === 'boolean') popOn[kind] = s[key];
    if (s.alertTiming === 'start' || s.alertTiming === 'end') alertTiming = s.alertTiming;
    if (Number.isFinite(s.glowStrength)) glowStrength = s.glowStrength;
    if (typeof s.liveList === 'boolean') liveList = s.liveList;
    if (typeof s.autoOpenList === 'boolean') autoOpenList = s.autoOpenList;
    if (typeof s.glowMode === 'boolean') glowMode = s.glowMode;
    for (const [kind, key] of Object.entries(GLOW_KEYS)) if (typeof s[key] === 'boolean') glowOn[kind] = s[key];
    if (listOpen) renderList();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [kind, key] of Object.entries(GLOW_KEYS)) if (changes[key]) glowOn[kind] = !!changes[key].newValue;
    for (const [kind, key] of Object.entries(POP_KEYS)) if (changes[key]) popOn[kind] = !!changes[key].newValue;
    if (changes.glowStrength && Number.isFinite(changes.glowStrength.newValue)) glowStrength = changes.glowStrength.newValue;
    if (changes.alertTiming) alertTiming = changes.alertTiming.newValue === 'end' ? 'end' : 'start';
    if (!changes.liveList && !changes.autoOpenList && !changes.glowMode) return;
    if (changes.liveList) liveList = !!changes.liveList.newValue;
    if (changes.glowMode) glowMode = !!changes.glowMode.newValue;
    if (changes.autoOpenList) {
      autoOpenList = !!changes.autoOpenList.newValue;
    }
    shownKey = '';
    if (listOpen) renderList();
  });
  // Claims playback has passed the end of (whatever the Live setting).
  // The moment a claim counts as said: as the speaker starts it, or just after
  // they finish it (the "Alert at" setting). Used for every alert.
  const alertMoment = (c) => (alertTiming === 'start'
    ? c.t
    : (Number.isFinite(c.tEnd) ? c.tEnd : c.t) + 0.5);
  const said = (c) => (video()?.currentTime || 0) >= alertMoment(c);
  // Only claims with a result are listed — never ones still queued or being checked.
  const ready = (c) => c.status === 'done' || c.status === 'skipped' || c.status === 'error';
  const heard = (c) => ready(c) && (!liveList || revealed.has(c.id) || said(c));
  let lastT = null; // video time at the last check, for auto-open
  let listEl = null;

  const VERDICT_LABELS = {
    FALSE: 'FALSE', MISLEADING: 'MISLEADING', TRUE: 'TRUE', UNVERIFIABLE: 'UNVERIFIABLE'
  };

  function claimLabel(c) {
    if (c.status === 'skipped') return { text: 'LIKELY TRUE · not searched', cls: 'skipped' };
    if (c.status === 'checking') return { text: 'CHECKING…', cls: 'pending' };
    if (c.status === 'pending') {
      // Claims the viewer already went past are skipped, to save usage.
      const now = video()?.currentTime || 0;
      return now > (c.tEnd || c.t) + 20
        ? { text: 'PASSED · not checked', cls: 'skipped' }
        : { text: 'QUEUED', cls: 'pending' };
    }
    if (c.status === 'error') return { text: 'ERROR', cls: 'error' };
    const v = VERDICT_LABELS[c.verdict] || 'UNVERIFIABLE';
    return { text: v, cls: v.toLowerCase() };
  }

  function toggleList() {
    listOpen = !listOpen;
    hidePeek();
    shownKey = '';
    renderStatus();
    renderList();
  }

  function renderList() {
    const p = player();
    if (!listOpen || !p) {
      listEl?.remove();
      listEl = null;
      return;
    }
    const keepScroll = listEl?.querySelector('.factflag-list-body')?.scrollTop || 0;
    listEl?.remove();
    listEl = document.createElement('div');
    listEl.className = 'factflag-list';
    stopPlayerEvents(listEl);
    listEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });

    const head = document.createElement('div');
    head.className = 'factflag-list-head';
    const visible = allClaims.filter(heard);
    head.append(line('factflag-list-title', liveList
      ? `Claims heard so far (${visible.length})`
      : `Claims checked so far (${visible.length})`));
    const live = document.createElement('button');
    live.className = `factflag-live${liveList ? ' on' : ''}`;
    live.textContent = liveList ? '● Live' : 'Live: off';
    live.title = liveList
      ? 'Showing each claim right after it is said. Click to show all claims found so far.'
      : 'Showing all claims found so far. Click to show them live, as they are said.';
    live.addEventListener('click', () => chrome.storage.local.set({ liveList: !liveList }));
    // Auto-open and glow mode are set on the settings page.
    head.appendChild(live);
    const close = document.createElement('button');
    close.className = 'factflag-card-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', toggleList);
    head.appendChild(close);
    listEl.appendChild(head);

    const body = document.createElement('div');
    body.className = 'factflag-list-body';
    if (!visible.length) {
      body.appendChild(line('factflag-list-empty', liveList
        ? 'No claims heard yet. Each claim shows up here right after it is said.'
        : 'No checkable claims yet. FactFlag checks about a minute ahead of where you are.'));
    }
    const firstRender = !shownKey;
    // Latest moment in the video first.
    for (const c of visible.sort((a, b) => b.t - a.t)) {
      const row = buildRow(c);
      if (c.id === flashId) row.classList.add('factflag-list-alert');
      else if (liveList && !firstRender && !shownIds.has(c.id)) row.classList.add('factflag-list-new');
      body.appendChild(row);
    }
    listEl.appendChild(body);
    p.appendChild(listEl);
    body.scrollTop = keepScroll;
    if (flashId) {
      const row = body.querySelector(`[data-id="${CSS.escape(String(flashId))}"]`);
      if (row) body.scrollTop = row.offsetTop - body.offsetTop - 4;
      flashId = null;
    }
    shownIds = new Set(visible.map((c) => c.id));
    shownKey = listKey();
  }

  // One claim: time (click to jump), verdict, Copy, claim, why, source.
  function buildRow(c) {
    const row = document.createElement('div');
    row.className = 'factflag-list-row';
    row.dataset.id = c.id;
    if (c.verdict === 'FALSE') row.classList.add('factflag-list-false');
    const top = document.createElement('div');
    top.className = 'factflag-list-top';
    const time = document.createElement('button');
    time.className = 'factflag-list-time';
    time.textContent = fmtTime(c.t);
    time.title = 'Jump to this moment';
    time.addEventListener('click', () => { const v = video(); if (v) v.currentTime = c.t; });
    const label = claimLabel(c);
    const chip = line(`factflag-chip factflag-chip-${label.cls}`, label.text);
    top.append(time, chip);
    if (c.status === 'done') {
      const copy = document.createElement('button');
      copy.className = 'factflag-card-copy';
      copy.textContent = 'Copy';
      copy.title = 'Copy the claim, quote, link and source to double-check it yourself';
      copy.addEventListener('click', async () => {
        const ok = await copyToClipboard(copyText(c));
        copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
        setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
      });
      top.appendChild(copy);
    }
    row.appendChild(top);
    row.appendChild(line('factflag-list-claim', c.claim));
    if (c.verdict === 'FALSE' && c.quote) row.appendChild(line('factflag-list-quote', `Speaker: “${c.quote}”`));
    const why = c.status === 'skipped' ? (c.triageReason ? `Screened as likely true: ${c.triageReason}` : '')
      : c.status === 'error' ? c.error : c.explanation;
    if (why) row.appendChild(line('factflag-list-why', why));
    if (c.verdict === 'FALSE' && c.evidenceQuote) {
      row.appendChild(line('factflag-list-quote', `Source says: “${c.evidenceQuote}”`));
    }
    if (c.sourceUrl) {
      const src = document.createElement('div');
      src.className = 'factflag-list-why';
      const a = document.createElement('a');
      a.href = c.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      let host = 'source';
      try { host = new URL(c.sourceUrl).hostname.replace(/^www\./, ''); } catch (_) {}
      // The page's title (when known) says which study or report it is.
      a.textContent = c.sourceTitle ? c.sourceTitle : host;
      src.append('Source: ', a, ...(c.sourceTitle ? [` (${host})`] : []));
      row.appendChild(src);
    }
    return row;
  }

  function listKey() {
    return allClaims.filter(heard).map((c) => c.id).join(',') || 'none';
  }
  // Pop-up / glow: only for claims whose result was ready at the moment
  // normal playback passed them. A result that arrives after the claim was
  // said (e.g. in the first minute of a video, before checking catches up)
  // never alerts — it just appears in the list. Seeking and ads don't count.
  function checkAutoOpen() {
    const v = video();
    const t = v?.currentTime || 0;
    const prev = lastT;
    if (player()?.classList.contains('ad-showing')) { lastT = null; return false; }
    lastT = t;
    if (prev === null || t < prev || t - prev > 3) return false;
    const fresh = allClaims.filter((c) => ready(c) && alertMoment(c) > prev && alertMoment(c) <= t);
    if (!fresh.length) return false;
    if (glowMode) {
      glowFor(fresh);
      // Verdicts set to also pop up do, unless the full list is open.
      const pop = fresh.filter((c) => popOn[verdictKind(c)]);
      if (pop.length && !listOpen) showPeek(pickPeek(pop));
      return false;
    }
    // The full list is open: its new rows already show up live.
    if (listOpen || !autoOpenList) return false;
    showPeek(pickPeek(fresh));
    return true;
  }

  // Add rows as playback reaches the end of each claim (and drop them again
  // after seeking back). timeupdate doesn't bubble, so listen in capture.
  document.addEventListener('timeupdate', (e) => {
    if (e.target !== video()) return;
    if (checkAutoOpen()) return;
    if (listOpen && listKey() !== shownKey) renderList();
  }, true);

  function hideTip() {
    tipEl?.remove();
    tipEl = null;
    player()?.classList.remove('factflag-hovering');
  }

  function showTip(markerEl, claim) {
    const p = player();
    if (!p) return;
    hideTip();
    p.classList.add('factflag-hovering');
    tipEl = document.createElement('div');
    tipEl.className = 'factflag-tip';
    const head = document.createElement('div');
    head.className = 'factflag-tip-head';
    head.textContent = `${claim.verdict || 'NOT CHECKED'} · ${fmtTime(claim.t)}`;
    const body = document.createElement('div');
    body.className = 'factflag-tip-claim';
    body.textContent = claim.claim;
    tipEl.append(head, body);
    if (claim.explanation) {
      const ex = document.createElement('div');
      ex.className = 'factflag-tip-explanation';
      ex.textContent = claim.explanation;
      tipEl.appendChild(ex);
    }
    if (claim.quote) {
      const q = document.createElement('div');
      q.className = 'factflag-tip-quote';
      q.textContent = `Speaker: “${claim.quote}”`;
      tipEl.appendChild(q);
    }
    if (claim.evidenceQuote) {
      const ev = document.createElement('div');
      ev.className = 'factflag-tip-quote';
      ev.textContent = `Source says: “${claim.evidenceQuote}”`;
      tipEl.appendChild(ev);
    }
    if (claim.sourceUrl) {
      const src = document.createElement('div');
      src.className = 'factflag-tip-source';
      try { src.textContent = `Source: ${new URL(claim.sourceUrl).hostname.replace(/^www\./, '')}`; } catch (_) {}
      tipEl.appendChild(src);
    }
    p.appendChild(tipEl);

    const pr = p.getBoundingClientRect();
    const mr = markerEl.getBoundingClientRect();
    const half = tipEl.offsetWidth / 2;
    const x = Math.min(Math.max(mr.left + mr.width / 2 - pr.left, half + 8), pr.width - half - 8);
    tipEl.style.left = `${x}px`;
    tipEl.style.bottom = `${pr.bottom - mr.top + 6}px`;
  }

  // Keep YouTube's own progress-bar handlers (scrub, preview thumbnail) from
  // reacting while the pointer is on one of our triangles.
  const STOP_EVENTS = ['mousedown', 'pointerdown', 'mousemove', 'pointermove', 'mouseover', 'mouseup', 'pointerup'];

  function renderMarkers() {
    const bar = progressBar();
    const v = video();
    const duration = v?.duration;
    if (!bar || !Number.isFinite(duration) || duration <= 0) return;

    const key = `${duration}|${claims.map((c) => `${c.id}:${c.t}:${c.verdict}`).join(',')}`;
    if (layerEl && bar.contains(layerEl) && key === renderedKey) return;
    renderedKey = key;

    layerEl?.remove();
    hideTip();
    layerEl = document.createElement('div');
    layerEl.className = 'factflag-markers';
    for (const claim of claims) {
      const m = document.createElement('div');
      m.className = `factflag-marker${claim.verdict ? ` factflag-${claim.verdict.toLowerCase()}` : ''}`;
      m.style.left = `${Math.min(100, (claim.t / duration) * 100)}%`;
      for (const ev of STOP_EVENTS) m.addEventListener(ev, (e) => e.stopPropagation());
      m.addEventListener('mouseenter', () => showTip(m, claim));
      m.addEventListener('mouseleave', hideTip);
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = video();
        if (vid) vid.currentTime = claim.t;
        hideTip();
        showInList(claim); // show it in the list, e.g. to copy it
      });
      layerEl.appendChild(m);
    }
    bar.appendChild(layerEl);
  }

  // YouTube sometimes rebuilds the player; re-attach if our elements disappear.
  setInterval(() => {
    if (statusText) renderStatus();
    if (listOpen && listEl && !player()?.contains(listEl)) renderList();
    if (claims.length) renderMarkers();
  }, 1000);

  function line(className, text) {
    const d = document.createElement('div');
    d.className = className;
    d.textContent = text;
    return d;
  }

  // Plain-text summary for double-checking a claim yourself.
  function copyText(claim) {
    const videoId = new URLSearchParams(location.search).get('v');
    const title = document.title.replace(/^\(\d+\)\s*/, '').replace(/ - YouTube$/, '');
    const link = videoId ? `https://youtu.be/${videoId}?t=${Math.floor(claim.t)}` : location.href;
    return [
      `Claim: ${claim.claim}`,
      claim.quote ? `Speaker's words: "${claim.quote}"` : '',
      `Said at ${fmtTime(claim.t)}${title ? ` in "${title}"` : ''} — ${link}`,
      '',
      `FactFlag verdict: ${claim.verdict || 'FALSE'}${claim.explanation ? ` — ${claim.explanation}` : ''}`,
      claim.evidenceQuote ? `Source says: "${claim.evidenceQuote}"` : '',
      claim.sourceUrl ? `Source: ${claim.sourceTitle ? `${claim.sourceTitle} — ` : ''}${claim.sourceUrl}` : ''
    ].filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== '')).join('\n').trim();
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Fallback for pages where the async clipboard API is blocked.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  // ---- Pop-up: one claim's row, right after it's said, for 10 seconds ----
  // The full list only opens when the viewer clicks the status line.
  const PEEK_MS = 10000;
  let peekEl = null;
  let peekId = null;
  let peekTick = null;

  function hidePeek() {
    clearInterval(peekTick);
    peekTick = null;
    peekEl?.remove();
    peekEl = null;
    peekId = null;
  }

  // Of several claims said at once, pop up a FALSE one, else the latest.
  function pickPeek(list) {
    return list.find((c) => c.verdict === 'FALSE') || list.reduce((a, b) => (b.t > a.t ? b : a));
  }

  function showPeek(claim) {
    const p = player();
    if (!p || peekId === claim.id) return;
    hidePeek();
    peekId = claim.id;
    peekEl = document.createElement('div');
    peekEl.className = 'factflag-list factflag-peek';
    stopPlayerEvents(peekEl);
    const row = buildRow(claim);
    row.classList.add(claim.verdict === 'FALSE' ? 'factflag-list-alert' : 'factflag-list-new');
    const close = document.createElement('button');
    close.className = 'factflag-card-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', hidePeek);
    row.querySelector('.factflag-list-top').appendChild(close);
    const body = document.createElement('div');
    body.className = 'factflag-list-body';
    body.appendChild(row);
    const timer = document.createElement('div');
    timer.className = 'factflag-list-timer';
    peekEl.append(body, timer);
    // The countdown also holds while the video is paused (see the timer below).
    // Pause only while the pointer is actually moved onto the pop-up — a
    // cursor that was already resting where it appeared doesn't count.
    let hovering = false;
    peekEl.addEventListener('mousemove', () => { hovering = true; });
    peekEl.addEventListener('mouseleave', () => { hovering = false; });
    let remaining = PEEK_MS;
    let last = performance.now();
    peekTick = setInterval(() => {
      const now = performance.now();
      // Paused video or mouse on the pop-up: hold the countdown, so there's
      // time to read.
      if (!hovering && !video()?.paused) remaining -= now - last;
      last = now;
      timer.style.width = `${Math.max(0, (remaining / PEEK_MS) * 100)}%`;
      if (remaining <= 0 || !p.contains(peekEl)) hidePeek();
    }, 100);
    p.appendChild(peekEl);
  }

  // Show a claim in the full list, scrolled to and highlighted (a triangle
  // was clicked).
  function showInList(claim) {
    hidePeek();
    revealed.add(claim.id);
    flashId = claim.id;
    if (!allClaims.some((c) => c.id === claim.id)) allClaims = [...allClaims, claim];
    if (!listOpen) shownKey = '';
    listOpen = true;
    renderStatus();
    renderList();
  }

  // A FALSE claim was just said: pop it up (or flash it in the open list).
  function alertClaim(claim) {
    if (glowMode) {
      glowFor([claim]);
      if (!popOn.false) return;
    }
    if (listOpen) {
      flashId = claim.id;
      renderList();
      return;
    }
    showPeek(claim);
  }

  // ---- Glow mode ----

  // Most serious verdict first, so a FALSE claim said together with a TRUE
  // one glows red.
  const GLOW_ORDER = ['FALSE', 'MISLEADING', 'UNVERIFIABLE', 'TRUE'];
  // false / misleading / true / unverifiable ("likely true" counts as true).
  function verdictKind(c) {
    if (c.status === 'skipped') return 'true';
    if (c.status === 'done') return GLOW_ORDER.includes(c.verdict) ? c.verdict.toLowerCase() : 'unverifiable';
    return null;
  }
  // The glow colour for a claim, or null if that verdict is set not to glow.
  function glowKind(c) {
    const kind = verdictKind(c);
    return kind && glowOn[kind] ? kind : null;
  }
  let glowEl = null;
  const glowedAt = new Map(); // claim id -> when it last glowed
  function glowFor(list) {
    // The FALSE alert and the list update can both ask to glow the same claim.
    const now = performance.now();
    const todo = list.filter((c) => !(now - (glowedAt.get(c.id) || -1e9) < 5000));
    todo.forEach((c) => glowedAt.set(c.id, now));
    const kinds = todo.map(glowKind).filter(Boolean);
    if (!kinds.length) return;
    const kind = GLOW_ORDER.map((v) => v.toLowerCase()).find((k) => kinds.includes(k));
    const p = player();
    if (!p) return;
    glowEl?.remove();
    glowEl = document.createElement('div');
    glowEl.className = `factflag-glow factflag-glow-${kind}`;
    self.factflagApplyGlowStrength(glowEl, glowStrength);
    glowEl.addEventListener('animationend', () => { glowEl?.remove(); glowEl = null; });
    p.appendChild(glowEl);
  }

  function clearAlerts() {
    hidePeek();
    revealed.clear();
    lastT = null;
    flashId = null;
  }

  // ---- Banner for a usage limit (stays until closed) ----
  let bannerEl = null;
  let bannerText = '';
  let bannerClosedFor = ''; // the viewer closed this banner; don't reopen it
  function showBanner(text, detail) {
    const p = player();
    if (!p || bannerClosedFor === text) return;
    if (bannerEl && p.contains(bannerEl) && bannerText === text) return;
    bannerEl?.remove();
    bannerText = text;
    bannerEl = document.createElement('div');
    bannerEl.className = 'factflag-banner';
    bannerEl.setAttribute('role', 'alert');
    stopPlayerEvents(bannerEl);
    bannerEl.appendChild(line('factflag-banner-text', `⚠ ${text}`));
    const close = document.createElement('button');
    close.className = 'factflag-card-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', () => {
      bannerClosedFor = text;
      bannerEl?.remove();
      bannerEl = null;
    });
    bannerEl.appendChild(close);
    if (detail) bannerEl.appendChild(line('factflag-banner-detail', detail));
    p.appendChild(bannerEl);
  }
  // Checking is running again (or a new video): remove the banner.
  function hideBanner() {
    bannerEl?.remove();
    bannerEl = null;
    bannerText = '';
    bannerClosedFor = '';
  }

  return {
    alert: alertClaim,
    clearAlerts,
    alertMoment,
    showBanner,
    hideBanner,
    setStatus(text) {
      statusText = text || '';
      renderStatus();
    },
    setAllClaims(list) {
      allClaims = list || [];
      if (listOpen) renderList();
    },
    setClaims(list) {
      claims = list || [];
      if (!claims.length) {
        layerEl?.remove();
        layerEl = null;
        renderedKey = '';
        hideTip();
      }
      renderMarkers();
    },
    clear() {
      this.setClaims([]);
      allClaims = [];
      listOpen = false;
      renderList();
      this.setStatus('');
      clearAlerts();
      hideBanner();
    }
  };
})();
