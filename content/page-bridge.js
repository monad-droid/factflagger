// FactFlag page bridge — runs inside YouTube's own page (the "MAIN" world) at
// document_start, before YouTube's player scripts load.
//
// Why this exists: YouTube's caption files (/api/timedtext) now come back EMPTY
// unless the request carries a "pot" (proof-of-origin) token that YouTube's own
// player generates. We can't make that token ourselves, so we watch the player's
// own caption requests, note the token, and reuse it to download the full
// caption track in JSON form. This all happens inside your logged-in YouTube tab;
// no outside service is involved.
(() => {
  if (window.__factflagBridge) return;
  window.__factflagBridge = true;

  const FROM_CS = 'factflag-cs';
  const FROM_PAGE = 'factflag-page';

  // videoId -> { pot, c, cver } captured from the player's own caption requests
  const potByVideo = new Map();

  function noteUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      if (!url.pathname.includes('/api/timedtext')) return;
      const pot = url.searchParams.get('pot');
      const v = url.searchParams.get('v');
      if (pot && v) {
        potByVideo.set(v, {
          pot,
          c: url.searchParams.get('c'),
          cver: url.searchParams.get('cver')
        });
      }
    } catch (_) { /* ignore unparseable URLs */ }
  }

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try { noteUrl(input instanceof Request ? input.url : String(input)); } catch (_) {}
    return origFetch.apply(this, arguments);
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try { noteUrl(String(url)); } catch (_) {}
    return origOpen.apply(this, arguments);
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs, stepMs = 200) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return fn();
  }

  function getPlayer() {
    return document.getElementById('movie_player');
  }

  function getPlayerResponse(videoId) {
    try {
      const pr = getPlayer()?.getPlayerResponse?.();
      if (pr?.videoDetails?.videoId === videoId) return pr;
    } catch (_) {}
    const init = window.ytInitialPlayerResponse;
    if (init?.videoDetails?.videoId === videoId) return init;
    return null;
  }

  function trackName(t) {
    return t.name?.simpleText || (t.name?.runs || []).map((r) => r.text).join('') || t.languageCode;
  }

  // Prefer manual English, then auto-generated English, then anything else.
  function pickTrack(tracks) {
    const isEn = (t) => (t.languageCode || '').toLowerCase().startsWith('en');
    const isAsr = (t) => t.kind === 'asr';
    return (
      tracks.find((t) => isEn(t) && !isAsr(t)) ||
      tracks.find((t) => isEn(t) && isAsr(t)) ||
      tracks.find((t) => !isAsr(t)) ||
      tracks[0]
    );
  }

  function parseJson3(text) {
    const data = JSON.parse(text);
    const segments = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const line = ev.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      segments.push({
        start: (ev.tStartMs || 0) / 1000,
        dur: (ev.dDurationMs || 0) / 1000,
        text: line
      });
    }
    return segments;
  }

  async function downloadTrack(track, potInfo) {
    const url = new URL(track.baseUrl, location.origin);
    url.searchParams.set('fmt', 'json3');
    if (potInfo) {
      url.searchParams.set('pot', potInfo.pot);
      url.searchParams.set('c', potInfo.c || 'WEB');
      if (potInfo.cver) url.searchParams.set('cver', potInfo.cver);
    }
    const res = await origFetch(url.toString(), { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error('empty response');
    return parseJson3(text);
  }

  // Make the player fetch captions once (so we can see its token) by briefly
  // toggling the CC button, then put CC back the way the user had it.
  async function capturePot(videoId) {
    if (potByVideo.has(videoId)) return potByVideo.get(videoId);

    // Don't toggle CC during an ad — the token would belong to the ad's video.
    await waitFor(() => !getPlayer()?.classList.contains('ad-showing'), 120000, 500);

    const btn = await waitFor(() => document.querySelector('#movie_player .ytp-subtitles-button'), 5000);
    if (!btn) return null;
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    if (wasOn) {
      btn.click();               // off
      await sleep(400);
      btn.click();               // back on -> triggers a fresh caption request
      return waitFor(() => potByVideo.get(videoId), 5000);
    }
    btn.click();                 // on -> triggers a caption request
    const info = await waitFor(() => potByVideo.get(videoId), 5000);
    btn.click();                 // back off
    return info;
  }

  async function getCaptions(videoId) {
    const pr = await waitFor(() => getPlayerResponse(videoId), 15000, 300);
    if (!pr) return { ok: false, reason: 'failed', error: 'player data not found' };

    const vd = pr.videoDetails || {};
    const meta = {
      videoTitle: vd.title || '',
      channel: vd.author || '',
      published: pr.microformat?.playerMicroformatRenderer?.publishDate || ''
    };
    if (vd.isLive || vd.isUpcoming) return { ok: false, reason: 'live', meta };

    const readTracks = () =>
      getPlayerResponse(videoId)?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    // Right after switching videos the caption list can arrive a moment late.
    const tracks = (await waitFor(() => (readTracks().length ? readTracks() : null), 4000, 400)) || [];
    if (!tracks.length) return { ok: false, reason: 'no_captions', meta };

    const track = pickTrack(tracks);
    const trackInfo = {
      ...meta,
      languageCode: track.languageCode,
      name: trackName(track),
      autoGenerated: track.kind === 'asr'
    };
    const errors = [];

    // Attempt 1: some tracks still work without a token.
    try {
      const segments = await downloadTrack(track, null);
      if (segments.length) return { ok: true, method: 'timedtext', track: trackInfo, segments };
    } catch (e) { errors.push(`no-token: ${e.message}`); }

    // Attempt 2: reuse the token from the player's own caption request.
    try {
      const potInfo = await capturePot(videoId);
      if (!potInfo) throw new Error('could not capture player token');
      const segments = await downloadTrack(track, potInfo);
      if (segments.length) return { ok: true, method: 'timedtext+pot', track: trackInfo, segments };
      errors.push('with-token: no segments');
    } catch (e) { errors.push(`with-token: ${e.message}`); }

    return { ok: false, reason: 'failed', meta, track: trackInfo, error: errors.join('; ') };
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== FROM_CS || msg.type !== 'GET_CAPTIONS') return;
    let result;
    try {
      result = await getCaptions(msg.videoId);
    } catch (e) {
      result = { ok: false, reason: 'failed', error: e.message };
    }
    window.postMessage(
      { source: FROM_PAGE, type: 'CAPTIONS_RESULT', reqId: msg.reqId, videoId: msg.videoId, result },
      location.origin
    );
  });
})();
