// FactFlag background service worker.
// All calls to outside APIs (Groq, Tavily) happen here, never in the content script.
importScripts('shared/defaults.js', 'prompts.js', 'lib/groq.js');

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const CHUNK_SECONDS = 120;
const LOG = '[FactFlag]';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

// Toolbar button opens settings.
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(self.FACTFLAG_DEFAULTS));
  return { ...self.FACTFLAG_DEFAULTS, ...stored };
}

// Settings page "Test Groq" button: checks the key works and both model IDs exist.
async function testGroq() {
  const s = await getSettings();
  if (!s.groqApiKey) return { ok: false, error: 'No Groq API key saved yet.' };
  let res;
  try {
    res = await fetch(`${GROQ_BASE}/models`, {
      headers: { Authorization: `Bearer ${s.groqApiKey}` }
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
  if (res.status === 401) return { ok: false, error: 'Groq rejected the API key (401).' };
  if (!res.ok) return { ok: false, error: `Groq returned HTTP ${res.status}.` };
  const body = await res.json();
  const ids = (body.data || []).map((m) => m.id);
  return {
    ok: true,
    detectionModelFound: ids.includes(s.detectionModel),
    verdictModelFound: ids.includes(s.verdictModel),
    detectionModel: s.detectionModel,
    verdictModel: s.verdictModel,
    available: ids.sort()
  };
}

// ---------------------------------------------------------------------------
// Per-video state. Kept in chrome.storage.session so it survives the service
// worker going to sleep; cleared when the browser closes.
// ---------------------------------------------------------------------------
const videoKey = (videoId) => `video:${videoId}`;
const tabsWatching = new Map(); // tabId -> videoId
const jobs = new Map();         // videoId -> { cancelled }

async function loadState(videoId) {
  return (await chrome.storage.session.get(videoKey(videoId)))[videoKey(videoId)] || null;
}

async function saveState(state) {
  await chrome.storage.session.set({ [videoKey(state.videoId)]: state });
  for (const [tabId, vid] of tabsWatching) {
    if (vid === state.videoId) {
      chrome.tabs.sendMessage(tabId, { type: 'STATE', state }).catch(() => tabsWatching.delete(tabId));
    }
  }
}

// The worker can be shut down after ~30s without extension activity, which would
// kill a long scan (e.g. while waiting out a rate limit). A cheap API call every
// 20s while work is running keeps it awake.
let keepAliveTimer = null;
function updateKeepAlive() {
  if (jobs.size && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  } else if (!jobs.size && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function fmtTime(sec) {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function makeChunks(segments) {
  const chunks = [];
  let cur = null;
  for (const seg of segments) {
    if (!cur || seg.start - cur.start >= CHUNK_SECONDS) {
      cur = { start: seg.start, end: seg.start, segments: [] };
      chunks.push(cur);
    }
    cur.segments.push(seg);
    cur.end = seg.start + (seg.dur || 0);
  }
  return chunks;
}

// Work outward from the viewer: the chunk they're in first, then forward, then earlier.
function chunkOrder(chunks, playhead) {
  let first = chunks.findIndex((c) => playhead < c.end);
  if (first === -1) first = 0;
  const order = [];
  for (let i = first; i < chunks.length; i++) order.push(i);
  for (let i = 0; i < first; i++) order.push(i);
  return order;
}

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          t: { type: 'number' },
          claim: { type: 'string' },
          quote: { type: 'string' },
          checkworthiness: { type: 'integer' }
        },
        required: ['t', 'claim', 'quote', 'checkworthiness'],
        additionalProperties: false
      }
    }
  },
  required: ['claims'],
  additionalProperties: false
};

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in values ? String(values[k]) : ''));
}

async function detectClaimsInChunk(chunk, meta, settings, onWait) {
  const P = self.FACTFLAG_PROMPTS;
  const transcript = chunk.segments.map((s) => `[${Math.floor(s.start)}] ${s.text}`).join('\n');
  const { json, usage } = await groqChatJson({
    apiKey: settings.groqApiKey,
    model: settings.detectionModel,
    system: fill(P.claimDetectionSystem, { MAX_CLAIMS: P.maxClaimsPerChunk }),
    user: fill(P.claimDetectionUser, {
      TITLE: meta.title || 'unknown',
      CHANNEL: meta.channel || 'unknown',
      RANGE: `${fmtTime(chunk.start)}–${fmtTime(chunk.end)}`,
      TRANSCRIPT: transcript
    }),
    schemaName: 'claims',
    schema: CLAIMS_SCHEMA,
    reasoningEffort: P.detectionReasoningEffort,
    onWait
  });
  if (usage) {
    console.info(LOG, `chunk ${fmtTime(chunk.start)}: ${usage.total_tokens} tokens ` +
      `(prompt ${usage.prompt_tokens}, completion ${usage.completion_tokens})`);
  }

  const claims = Array.isArray(json.claims) ? json.claims : [];
  const valid = claims.filter((c) => c && typeof c.claim === 'string' && c.claim.trim());
  const kept = valid.filter((c) => Number(c.checkworthiness) >= P.minCheckworthiness);
  if (valid.length !== kept.length) {
    console.info(LOG, `chunk ${fmtTime(chunk.start)}: dropped ${valid.length - kept.length} low-scoring claim(s)`);
  }
  return kept
    .sort((a, b) => b.checkworthiness - a.checkworthiness)
    .slice(0, P.maxClaimsPerChunk)
    .map((c) => {
      // Snap the timestamp to the start of the transcript line it falls in.
      let t = Number(c.t);
      if (!Number.isFinite(t) || t < chunk.start || t > chunk.end) t = chunk.start;
      const line = [...chunk.segments].reverse().find((s) => s.start <= t + 0.5) || chunk.segments[0];
      return {
        t: line.start,
        claim: c.claim.trim(),
        quote: (c.quote || '').trim(),
        checkworthiness: Number(c.checkworthiness)
      };
    });
}

async function runDetection(videoId, segments, meta, playhead) {
  const job = { cancelled: false };
  jobs.set(videoId, job);
  updateKeepAlive();

  const chunks = makeChunks(segments);
  const state = {
    videoId,
    title: meta.title || '',
    status: 'scanning',
    chunksTotal: chunks.length,
    chunksDone: 0,
    claims: [],
    note: '',
    error: ''
  };
  await saveState(state);

  try {
    const settings = await getSettings();
    if (!settings.groqApiKey) throw new Error('Add your Groq API key in FactFlag settings.');

    let nextId = 1;
    for (const i of chunkOrder(chunks, playhead)) {
      if (job.cancelled) return;
      const found = await detectClaimsInChunk(chunks[i], meta, settings, (secs) => {
        state.note = `Groq rate limit — waiting ${secs}s`;
        saveState(state);
      });
      if (job.cancelled) return;
      for (const c of found) state.claims.push({ id: nextId++, ...c });
      state.claims.sort((a, b) => a.t - b.t);
      state.chunksDone++;
      state.note = '';
      await saveState(state);
    }
    state.status = 'done';
    await saveState(state);
    console.info(LOG, `Scan complete for ${videoId}: ${state.claims.length} claims.`);
  } catch (e) {
    console.error(LOG, `Claim detection failed for ${videoId}:`, e.message);
    state.status = 'error';
    state.error = e.message;
    state.note = '';
    await saveState(state);
  } finally {
    if (jobs.get(videoId) === job) jobs.delete(videoId);
    updateKeepAlive();
  }
}

// Stop work for a video nobody is watching any more.
function releaseVideo(tabId) {
  const old = tabsWatching.get(tabId);
  tabsWatching.delete(tabId);
  if (!old) return;
  if ([...tabsWatching.values()].includes(old)) return;
  const job = jobs.get(old);
  if (job) {
    job.cancelled = true;
    jobs.delete(old);
    // Clear the half-finished scan so it restarts cleanly next time.
    chrome.storage.session.remove(videoKey(old));
    updateKeepAlive();
  }
}

async function onTranscript(tabId, msg) {
  if (tabsWatching.get(tabId) !== msg.videoId) releaseVideo(tabId);
  tabsWatching.set(tabId, msg.videoId);

  const settings = await getSettings();
  if (!settings.enabled) return;

  const existing = await loadState(msg.videoId);
  if (existing && (existing.status === 'done' || jobs.has(msg.videoId))) {
    chrome.tabs.sendMessage(tabId, { type: 'STATE', state: existing }).catch(() => {});
    return;
  }
  runDetection(msg.videoId, msg.segments, { title: msg.title, channel: msg.channel }, msg.playhead || 0);
}

chrome.tabs.onRemoved.addListener((tabId) => releaseVideo(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TEST_GROQ') {
    testGroq().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (msg?.type === 'TRANSCRIPT') {
    onTranscript(tabId, msg);
  } else if (msg?.type === 'LEFT_VIDEO') {
    releaseVideo(tabId);
  }
});
