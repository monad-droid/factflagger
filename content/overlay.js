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
      p.appendChild(statusEl);
    }
    statusEl.textContent = statusText ? `FactFlag · ${statusText}` : '';
  }

  function hideTip() {
    tipEl?.remove();
    tipEl = null;
  }

  function showTip(markerEl, claim) {
    const p = player();
    if (!p) return;
    hideTip();
    tipEl = document.createElement('div');
    tipEl.className = 'factflag-tip';
    const head = document.createElement('div');
    head.className = 'factflag-tip-head';
    head.textContent = `${fmtTime(claim.t)} · NOT CHECKED YET`;
    const body = document.createElement('div');
    body.textContent = claim.claim;
    tipEl.append(head, body);
    if (claim.quote) {
      const q = document.createElement('div');
      q.className = 'factflag-tip-quote';
      q.textContent = `“${claim.quote}”`;
      tipEl.appendChild(q);
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

    const key = `${duration}|${claims.map((c) => `${c.id}:${c.t}`).join(',')}`;
    if (layerEl && bar.contains(layerEl) && key === renderedKey) return;
    renderedKey = key;

    layerEl?.remove();
    hideTip();
    layerEl = document.createElement('div');
    layerEl.className = 'factflag-markers';
    for (const claim of claims) {
      const m = document.createElement('div');
      m.className = 'factflag-marker';
      m.style.left = `${Math.min(100, (claim.t / duration) * 100)}%`;
      for (const ev of STOP_EVENTS) m.addEventListener(ev, (e) => e.stopPropagation());
      m.addEventListener('mouseenter', () => showTip(m, claim));
      m.addEventListener('mouseleave', hideTip);
      m.addEventListener('click', (e) => {
        e.stopPropagation();
        const vid = video();
        if (vid) vid.currentTime = claim.t;
      });
      layerEl.appendChild(m);
    }
    bar.appendChild(layerEl);
  }

  // YouTube sometimes rebuilds the player; re-attach if our elements disappear.
  setInterval(() => {
    if (statusText) renderStatus();
    if (claims.length) renderMarkers();
  }, 1000);

  return {
    setStatus(text) {
      statusText = text || '';
      renderStatus();
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
      this.setStatus('');
    }
  };
})();
