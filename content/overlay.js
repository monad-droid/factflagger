// FactFlag on-video UI: a status label on the player, triangles on the progress
// bar at each claim's timestamp, and a hover card with the claim.
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
  let listEl = null;

  const VERDICT_LABELS = {
    FALSE: 'FALSE', MISLEADING: 'MISLEADING', TRUE: 'TRUE', UNVERIFIABLE: 'UNVERIFIABLE'
  };

  function claimLabel(c) {
    if (c.status === 'skipped') return { text: 'LIKELY TRUE · not searched', cls: 'skipped' };
    if (c.status === 'pending' || c.status === 'checking') return { text: 'CHECKING…', cls: 'pending' };
    if (c.status === 'error') return { text: 'ERROR', cls: 'error' };
    const v = VERDICT_LABELS[c.verdict] || 'UNVERIFIABLE';
    return { text: v, cls: v.toLowerCase() };
  }

  function toggleList() {
    listOpen = !listOpen;
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
    head.append(line('factflag-list-title', `Claims checked so far (${allClaims.length})`));
    const close = document.createElement('button');
    close.className = 'factflag-card-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', toggleList);
    head.appendChild(close);
    listEl.appendChild(head);

    const body = document.createElement('div');
    body.className = 'factflag-list-body';
    if (!allClaims.length) {
      body.appendChild(line('factflag-list-empty', 'No checkable claims yet. FactFlag checks about a minute ahead of where you are.'));
    }
    for (const c of [...allClaims].sort((a, b) => a.t - b.t)) {
      const row = document.createElement('div');
      row.className = 'factflag-list-row';
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
      row.appendChild(top);
      row.appendChild(line('factflag-list-claim', c.claim));
      const why = c.status === 'skipped' ? (c.triageReason ? `Screened as likely true: ${c.triageReason}` : '')
        : c.status === 'error' ? c.error : c.explanation;
      if (why) row.appendChild(line('factflag-list-why', why));
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
    p.appendChild(listEl);
    body.scrollTop = keepScroll;
  }

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
        showCardNow(claim); // reopen its card, e.g. to copy it
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

  // ---- Alert card ----
  // One card at a time; later alerts wait in a queue. Hovering the card pauses
  // its countdown so there's time to read or click the source.
  const cardQueue = [];
  let cardEl = null;

  // How long the card stays up (hovering pauses the countdown).
  const CARD_MS = 10000;
  function readingMs() {
    return CARD_MS;
  }

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

  function closeCard() {
    cardEl?._ffStop?.();
    cardEl?.remove();
    cardEl = null;
    if (cardQueue.length) openCard(cardQueue.shift());
  }

  function openCard(claim) {
    const p = player();
    if (!p) return;
    cardEl = document.createElement('div');
    cardEl.className = 'factflag-card';
    cardEl.setAttribute('role', 'alert');

    const head = document.createElement('div');
    head.className = 'factflag-card-head';
    const badge = line('factflag-card-badge', claim.verdict || 'FALSE');
    const time = line('factflag-card-time', `said at ${fmtTime(claim.t)}`);
    const close = document.createElement('button');
    close.className = 'factflag-card-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';
    close.addEventListener('click', closeCard);
    const copy = document.createElement('button');
    copy.className = 'factflag-card-copy';
    copy.textContent = 'Copy';
    copy.title = 'Copy the claim, quote, link and source to double-check it yourself';
    copy.addEventListener('click', async () => {
      const ok = await copyToClipboard(copyText(claim));
      copy.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1800);
    });
    head.append(badge, time, copy, close);
    cardEl.appendChild(head);

    cardEl.appendChild(line('factflag-card-claim', claim.claim));
    if (claim.quote) cardEl.appendChild(line('factflag-card-quote', `Speaker: “${claim.quote}”`));
    if (claim.explanation) cardEl.appendChild(line('factflag-card-line', claim.explanation));
    if (claim.evidenceQuote) cardEl.appendChild(line('factflag-card-quote', `Source says: “${claim.evidenceQuote}”`));
    if (claim.sourceUrl) {
      const src = document.createElement('div');
      src.className = 'factflag-card-line';
      const a = document.createElement('a');
      a.href = claim.sourceUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      try { a.textContent = new URL(claim.sourceUrl).hostname.replace(/^www\./, ''); } catch (_) { a.textContent = 'source'; }
      src.append('Source: ', a);
      cardEl.appendChild(src);
    }

    const timer = document.createElement('div');
    timer.className = 'factflag-card-timer';
    cardEl.appendChild(timer);

    // Clicks on the card must not reach the player (which would pause/play).
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick']) {
      cardEl.addEventListener(ev, (e) => e.stopPropagation());
    }

    // Countdown that pauses while the pointer is over the card.
    const total = readingMs(claim);
    let remaining = total;
    let last = performance.now();
    let hovering = false;
    cardEl.addEventListener('mouseenter', () => { hovering = true; });
    cardEl.addEventListener('mouseleave', () => { hovering = false; last = performance.now(); });
    const tick = setInterval(() => {
      const now = performance.now();
      if (!hovering) remaining -= now - last;
      last = now;
      timer.style.width = `${Math.max(0, (remaining / total) * 100)}%`;
      if (remaining <= 0) closeCard();
    }, 100);
    cardEl._ffStop = () => clearInterval(tick);

    p.appendChild(cardEl);
  }

  // Show this claim's card right away, replacing whatever card is open.
  function showCardNow(claim) {
    cardEl?._ffStop?.();
    cardEl?.remove();
    cardEl = null;
    openCard(claim);
  }

  function alertClaim(claim) {
    if (cardEl) cardQueue.push(claim);
    else openCard(claim);
  }

  function clearCards() {
    cardQueue.length = 0;
    cardEl?._ffStop?.();
    cardEl?.remove();
    cardEl = null;
  }

  return {
    alert: alertClaim,
    clearAlerts: clearCards,
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
      clearCards();
    }
  };
})();
