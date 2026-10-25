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
  // True while the list is open because a FALSE claim opened it; it closes
  // itself after AUTO_CLOSE_MS unless hovered or used.
  let autoOpened = false;
  let shownKey = '';
  let liveList = self.FACTFLAG_DEFAULTS.liveList;
  let autoOpenList = self.FACTFLAG_DEFAULTS.autoOpenList;
  chrome.storage.local.get(['liveList', 'autoOpenList']).then((s) => {
    if (typeof s.liveList === 'boolean') liveList = s.liveList;
    if (typeof s.autoOpenList === 'boolean') autoOpenList = s.autoOpenList;
    if (listOpen) renderList();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.liveList && !changes.autoOpenList)) return;
    if (changes.liveList) liveList = !!changes.liveList.newValue;
    if (changes.autoOpenList) {
      autoOpenList = !!changes.autoOpenList.newValue;
      if (autoOpenList) stopAutoClose();
    }
    shownKey = '';
    if (listOpen) renderList();
  });
  // Claims playback has passed the end of (whatever the Live setting).
  const said = (c) => (video()?.currentTime || 0) >= (c.tEnd || c.t) + 0.5;
  let saidIds = new Set();
  const heard = (c) => !liveList || revealed.has(c.id) || (video()?.currentTime || 0) >= (c.tEnd || c.t) + 0.5;
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
    stopAutoClose();
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
    // Using the list (a click or scroll) keeps it open.
    listEl.addEventListener('click', stopAutoClose);
    listEl.addEventListener('wheel', stopAutoClose, { passive: true });

    const head = document.createElement('div');
    head.className = 'factflag-list-head';
    const visible = allClaims.filter(heard);
    const ahead = allClaims.length - visible.length;
    head.append(line('factflag-list-title', liveList
      ? `Claims heard so far (${visible.length})${ahead ? ` · ${ahead} lined up ahead` : ''}`
      : `Claims found so far (${visible.length})`));
    const live = document.createElement('button');
    live.className = `factflag-live${liveList ? ' on' : ''}`;
    live.textContent = liveList ? '● Live' : 'Live: off';
    live.title = liveList
      ? 'Showing each claim right after it is said. Click to show all claims found so far.'
      : 'Showing all claims found so far. Click to show them live, as they are said.';
    live.addEventListener('click', () => chrome.storage.local.set({ liveList: !liveList }));
    const auto = document.createElement('button');
    auto.className = `factflag-live${autoOpenList ? ' on' : ''}`;
    auto.textContent = autoOpenList ? 'Auto-open' : 'Auto-open: off';
    auto.title = autoOpenList
      ? 'This list opens by itself whenever a new claim is said. Click to open it only for FALSE claims.'
      : 'This list opens by itself only for FALSE claims. Click to open it for every new claim.';
    auto.addEventListener('click', () => chrome.storage.local.set({ autoOpenList: !autoOpenList }));
    head.append(live, auto);
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
      const row = document.createElement('div');
      row.className = 'factflag-list-row';
      row.dataset.id = c.id;
      if (c.verdict === 'FALSE') row.classList.add('factflag-list-false');
      if (c.id === flashId) row.classList.add('factflag-list-alert');
      else if (liveList && !firstRender && !shownIds.has(c.id)) row.classList.add('factflag-list-new');
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
        try { a.textContent = new URL(c.sourceUrl).hostname.replace(/^www\./, ''); } catch (_) { a.textContent = 'source'; }
        src.append('Source: ', a);
        row.appendChild(src);
      }
      body.appendChild(row);
    }
    listEl.appendChild(body);
    if (autoOpened) {
      const timer = document.createElement('div');
      timer.className = 'factflag-list-timer';
      timer.style.width = `${Math.max(0, (autoRemaining / AUTO_CLOSE_MS) * 100)}%`;
      listEl.appendChild(timer);
    }
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

  function listKey() {
    return allClaims.filter(heard).map((c) => c.id).join(',') || 'none';
  }
  // Add rows as playback reaches the end of each claim (and drop them again
  // after seeking back). timeupdate doesn't bubble, so listen in capture.
  document.addEventListener('timeupdate', (e) => {
    if (e.target !== video()) return;
    // Auto-open: a claim was just said (not one skipped past by seeking).
    const nowSaid = new Set(allClaims.filter(said).map((c) => c.id));
    const fresh = [...nowSaid].some((id) => !saidIds.has(id));
    const t = video().currentTime;
    const playedThrough = allClaims.some((c) => !saidIds.has(c.id) && nowSaid.has(c.id) &&
      t - ((c.tEnd || c.t) + 0.5) < 3);
    saidIds = nowSaid;
    if (fresh && playedThrough && autoOpenList && !listOpen) {
      stopAutoClose();
      listOpen = true;
      shownKey = '';
      renderStatus();
      renderList();
      return;
    }
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
        showInList(claim, false); // show it in the list, e.g. to copy it
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
      claim.sourceUrl ? `Source: ${claim.sourceUrl}` : ''
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

  // ---- FALSE-claim alert: open the list on that claim ----
  // How long a list opened by an alert stays up (hovering pauses the countdown).
  const AUTO_CLOSE_MS = 10000;
  let autoRemaining = 0;
  let autoTick = null;

  function stopAutoClose() {
    autoOpened = false;
    clearInterval(autoTick);
    autoTick = null;
    listEl?.querySelector('.factflag-list-timer')?.remove();
  }

  function startAutoClose() {
    clearInterval(autoTick);
    autoOpened = true;
    autoRemaining = AUTO_CLOSE_MS;
    let last = performance.now();
    autoTick = setInterval(() => {
      const now = performance.now();
      if (!listEl?.matches(':hover')) autoRemaining -= now - last;
      last = now;
      const timer = listEl?.querySelector('.factflag-list-timer');
      if (timer) timer.style.width = `${Math.max(0, (autoRemaining / AUTO_CLOSE_MS) * 100)}%`;
      if (autoRemaining <= 0) {
        stopAutoClose();
        listOpen = false;
        renderStatus();
        renderList();
      }
    }, 100);
  }

  // Show a claim in the list, scrolled to and highlighted. auto = opened by
  // an alert (closes itself) rather than by the viewer (stays open).
  function showInList(claim, auto) {
    revealed.add(claim.id);
    flashId = claim.id;
    if (!allClaims.some((c) => c.id === claim.id)) allClaims = [...allClaims, claim];
    if (auto) {
      // Closes itself only if Auto-open is off and the viewer didn't open it.
      if (!autoOpenList && (!listOpen || autoOpened)) startAutoClose();
    } else {
      stopAutoClose();
    }
    if (!listOpen) shownKey = '';
    listOpen = true;
    renderStatus();
    renderList();
  }

  function alertClaim(claim) {
    showInList(claim, true);
  }

  function clearAlerts() {
    stopAutoClose();
    revealed.clear();
    saidIds = new Set();
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
