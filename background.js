// FactFlag background service worker.
// All calls to outside APIs (Groq, Tavily) happen here, never in the content script.
importScripts('shared/defaults.js', 'prompts.js', 'lib/groq.js', 'lib/tavily.js');

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
const jobs = new Map();         // videoId -> { cancelled, playhead, ... }

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

// Captions arrive as short on-screen fragments ("to do something productive,").
// Join them back into whole sentences so the model judges complete statements.
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
const SOUND_TAG = /^[\[(][^\])]*[\])]$/;     // "(Laughter)", "[Applause]"
const MAX_SENTENCE_WORDS = 45;               // safety cap for unpunctuated auto-captions
const MAX_SENTENCE_SECONDS = 30;
const PAUSE_SPLIT_SECONDS = 1.2;             // only used when captions have no punctuation
const CONTEXT_SENTENCES = 4;                 // earlier sentences shown to the model for context

function buildSentences(segments) {
  const punctuated = segments.filter((s) => /[.!?]["'”’)\]]*$/.test(s.text)).length;
  const hasPunctuation = punctuated / Math.max(segments.length, 1) > 0.1;
  const sentences = [];
  let cur = null;
  const flush = () => { if (cur) sentences.push(cur); cur = null; };

  for (const seg of segments) {
    const segEnd = seg.start + (seg.dur || 0);
    if (SOUND_TAG.test(seg.text)) {
      flush();
      sentences.push({ start: seg.start, end: segEnd, text: seg.text });
      continue;
    }
    if (cur && !hasPunctuation && seg.start - cur.end > PAUSE_SPLIT_SECONDS) flush();
    if (!cur) {
      cur = { start: seg.start, end: segEnd, text: seg.text };
    } else {
      cur.text += ` ${seg.text}`;
      cur.end = Math.max(cur.end, segEnd);
    }
    const words = cur.text.split(/\s+/).length;
    if (SENTENCE_END.test(cur.text) || words >= MAX_SENTENCE_WORDS ||
        cur.end - cur.start >= MAX_SENTENCE_SECONDS) {
      flush();
    }
  }
  flush();
  return sentences;
}

// ~2-minute chunks that always end on a sentence boundary.
function makeChunks(segments) {
  const sentences = buildSentences(segments);
  const chunks = [];
  let cur = null;
  sentences.forEach((sent, i) => {
    if (!cur || sent.start - cur.start >= CHUNK_SECONDS) {
      cur = {
        start: sent.start,
        end: sent.end,
        sentences: [],
        context: sentences.slice(Math.max(0, i - CONTEXT_SENTENCES), i)
      };
      chunks.push(cur);
    }
    cur.sentences.push(sent);
    cur.end = Math.max(cur.end, sent.end);
  });
  return chunks;
}

// Work outward from the viewer: whatever is at or just ahead of the playhead
// first, moving forward; things already behind the playhead come last
// (nearest first).
function pickNearest(items, playhead, startOf, endOf) {
  let best = null;
  let bestRank = Infinity;
  for (const it of items) {
    const ahead = endOf(it) >= playhead;
    const rank = ahead ? Math.max(0, startOf(it) - playhead) : 1e9 + (playhead - endOf(it));
    if (rank < bestRank) { bestRank = rank; best = it; }
  }
  return best;
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
    },
    speaker_concepts: { type: 'array', items: { type: 'string' } }
  },
  required: ['claims', 'speaker_concepts'],
  additionalProperties: false
};

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in values ? String(values[k]) : ''));
}

// `concepts` is the running list of the speaker's own metaphors/characters
// (e.g. "Instant Gratification Monkey"), shared across chunks of one video.
async function detectClaimsInChunk(chunk, meta, settings, concepts, onWait) {
  const P = self.FACTFLAG_PROMPTS;
  const asLines = (list) => list.map((s) => `[${Math.floor(s.start)}] ${s.text}`).join('\n');
  const transcript = asLines(chunk.sentences);
  const context = chunk.context.length ? asLines(chunk.context) : '(start of video)';
  const { json, usage } = await groqChatJson({
    apiKey: settings.groqApiKey,
    model: settings.detectionModel,
    system: fill(P.claimDetectionSystem, { MAX_CLAIMS: P.maxClaimsPerChunk }),
    user: fill(P.claimDetectionUser, {
      TITLE: meta.title || 'unknown',
      CHANNEL: meta.channel || 'unknown',
      RANGE: `${fmtTime(chunk.start)}–${fmtTime(chunk.end)}`,
      CONCEPTS: concepts.size ? [...concepts].join('; ') : '(none yet)',
      CONTEXT: context,
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

  for (const name of Array.isArray(json.speaker_concepts) ? json.speaker_concepts : []) {
    const clean = String(name || '').trim();
    if (clean && clean.length <= 60) concepts.add(clean);
  }
  // Backstop: drop claims that are really about one of the speaker's own
  // metaphors. Only multi-word names, so a vague one like "brain" can't
  // wipe out real claims.
  const aboutConcept = (c) => [...concepts].some((name) =>
    name.split(/\s+/).length >= 2 && c.claim.toLowerCase().includes(name.toLowerCase()));

  const claims = Array.isArray(json.claims) ? json.claims : [];
  const valid = claims.filter((c) => c && typeof c.claim === 'string' && c.claim.trim());
  // Drop claims outside this chunk (e.g. taken from the context lines by mistake).
  const inChunk = (c) => Number(c.t) >= Math.floor(chunk.start) && Number(c.t) <= chunk.end;
  const kept = valid.filter((c) =>
    inChunk(c) && Number(c.checkworthiness) >= P.minCheckworthiness && !aboutConcept(c));
  if (valid.length !== kept.length) {
    console.info(LOG, `chunk ${fmtTime(chunk.start)}: dropped ${valid.length - kept.length} claim(s) ` +
      '(low score, outside this section, or about the speaker\'s own metaphors)');
  }
  return kept
    .sort((a, b) => b.checkworthiness - a.checkworthiness)
    .slice(0, P.maxClaimsPerChunk)
    .map((c) => {
      // Snap the timestamp to the start of the sentence it falls in.
      const t = Number(c.t);
      const line = [...chunk.sentences].reverse().find((s) => s.start <= t + 0.5) || chunk.sentences[0];
      return {
        t: line.start,
        claim: c.claim.trim(),
        quote: (c.quote || '').trim(),
        checkworthiness: Number(c.checkworthiness)
      };
    });
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'] },
    explanation: { type: 'string' },
    source_url: { type: 'string' }
  },
  required: ['verdict', 'explanation', 'source_url'],
  additionalProperties: false
};

async function verifyClaim(claim, meta, settings, onWait) {
  const P = self.FACTFLAG_PROMPTS;
  const results = await tavilySearch({
    apiKey: settings.tavilyApiKey,
    query: claim.claim,
    maxResults: P.searchResultsPerClaim,
    onWait
  });
  if (!results.length) {
    return { verdict: 'UNVERIFIABLE', explanation: 'The web search returned no results.', sourceUrl: '', sourceTitle: '' };
  }
  const resultsText = results.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}${r.published ? `\nPublished: ${r.published}` : ''}\n${r.content}`
  ).join('\n\n');

  const { json, usage } = await groqChatJson({
    apiKey: settings.groqApiKey,
    model: settings.verdictModel,
    system: P.verdictSystem,
    user: fill(P.verdictUser, {
      TITLE: meta.title || 'unknown',
      PUBLISHED: meta.published || 'unknown',
      CLAIM: claim.claim,
      QUOTE: claim.quote,
      RESULTS: resultsText
    }),
    schemaName: 'verdict',
    schema: VERDICT_SCHEMA,
    reasoningEffort: P.verdictReasoningEffort,
    onWait
  });
  if (usage) {
    console.info(LOG, `verdict ${fmtTime(claim.t)}: ${usage.total_tokens} tokens ` +
      `(prompt ${usage.prompt_tokens}, completion ${usage.completion_tokens})`);
  }

  let verdict = ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'].includes(json.verdict) ? json.verdict : 'UNVERIFIABLE';
  let explanation = String(json.explanation || '').trim();
  // The source must be one of the search results — never a URL the model made up.
  const source = results.find((r) => r.url === String(json.source_url || '').trim());
  if (!source && verdict !== 'UNVERIFIABLE' && verdict !== 'TRUE') {
    // A FALSE/MISLEADING verdict with no real source behind it isn't trustworthy.
    console.info(LOG, `verdict ${fmtTime(claim.t)}: ${verdict} downgraded — source URL not in search results`);
    verdict = 'UNVERIFIABLE';
    explanation = `${explanation} (Downgraded: no matching source.)`.trim();
  }
  return { verdict, explanation, sourceUrl: source?.url || '', sourceTitle: source?.title || '' };
}

// Errors that should stop all checking for this video rather than skip one claim.
function isFatal(e) {
  return e?.fatal === true || e?.status === 401;
}

async function detectLoop(job, state, chunks, meta, settings) {
  const pending = new Set(chunks);
  const concepts = new Set();
  let nextId = 1;
  while (pending.size && !job.cancelled) {
    const chunk = pickNearest(pending, job.playhead, (c) => c.start, (c) => c.end);
    pending.delete(chunk);
    const found = await detectClaimsInChunk(chunk, meta, settings, concepts, (secs) => {
      state.note = `Groq rate limit — waiting ${secs}s`;
      saveState(state);
    });
    if (job.cancelled) return;
    if (concepts.size) console.info(LOG, `speaker's own concepts so far: ${[...concepts].join('; ')}`);
    for (const c of found) state.claims.push({ id: nextId++, status: 'pending', ...c });
    state.claims.sort((a, b) => a.t - b.t);
    state.chunksDone++;
    state.note = '';
    job.wake?.();
    await saveState(state);
  }
}

async function verifyLoop(job, state, meta, settings) {
  while (!job.cancelled) {
    const pending = state.claims.filter((c) => c.status === 'pending');
    if (!pending.length) {
      if (job.detectDone) return;
      await new Promise((resolve) => { job.wake = resolve; });
      job.wake = null;
      continue;
    }
    const claim = pickNearest(pending, job.playhead, (c) => c.t, (c) => c.t);
    claim.status = 'checking';
    try {
      const result = await verifyClaim(claim, meta, settings, (secs) => {
        state.note = `rate limit — waiting ${secs}s`;
        saveState(state);
      });
      if (job.cancelled) return;
      Object.assign(claim, result, { status: 'done' });
      console.info(LOG, `${fmtTime(claim.t)} ${claim.verdict}: ${claim.claim}`);
    } catch (e) {
      if (isFatal(e)) throw e;
      console.warn(LOG, `Could not check claim at ${fmtTime(claim.t)}: ${e.message}`);
      Object.assign(claim, { status: 'error', error: e.message });
    }
    state.checked = state.claims.filter((c) => c.status === 'done' || c.status === 'error').length;
    state.note = '';
    await saveState(state);
  }
}

async function runVideo(videoId, segments, meta, playhead) {
  const job = { cancelled: false, playhead, detectDone: false, wake: null };
  jobs.set(videoId, job);
  updateKeepAlive();

  const chunks = makeChunks(segments);
  const state = {
    videoId,
    title: meta.title || '',
    status: 'scanning',
    chunksTotal: chunks.length,
    chunksDone: 0,
    checked: 0,
    claims: [],
    note: '',
    error: ''
  };
  await saveState(state);

  try {
    const settings = await getSettings();
    if (!settings.groqApiKey) throw new Error('Add your Groq API key in FactFlag settings.');
    if (!settings.tavilyApiKey) throw new Error('Add your Tavily API key in FactFlag settings.');

    // Finding claims and checking them run side by side (they use different
    // models, so they don't compete for the same rate limits).
    const verifying = verifyLoop(job, state, meta, settings).catch((e) => {
      job.fatalError = e;   // e.g. Tavily key rejected or monthly limit hit:
      job.cancelled = true; // stop finding claims too, no point continuing
    });
    try {
      await detectLoop(job, state, chunks, meta, settings);
    } finally {
      job.detectDone = true;
      job.wake?.();
    }
    await verifying;
    if (job.fatalError) throw job.fatalError;
    if (job.cancelled) return;
    state.status = 'done';
    await saveState(state);
    const falseCount = state.claims.filter((c) => c.verdict === 'FALSE').length;
    console.info(LOG, `Finished ${videoId}: ${state.claims.length} claims checked, ${falseCount} false.`);
  } catch (e) {
    job.cancelled = true;
    job.wake?.();
    console.error(LOG, `Checking stopped for ${videoId}:`, e.message);
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
    job.wake?.();
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
  runVideo(
    msg.videoId,
    msg.segments,
    { title: msg.title, channel: msg.channel, published: msg.published },
    msg.playhead || 0
  );
}

chrome.tabs.onRemoved.addListener((tabId) => releaseVideo(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TEST_GROQ') {
    testGroq().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === 'TEST_TAVILY') {
    getSettings()
      .then((s) => (s.tavilyApiKey ? tavilyUsage(s.tavilyApiKey) : { ok: false, error: 'No Tavily API key saved yet.' }))
      .catch((e) => ({ ok: false, error: `Network error: ${e.message}` }))
      .then(sendResponse);
    return true;
  }
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (msg?.type === 'TRANSCRIPT') {
    onTranscript(tabId, msg);
  } else if (msg?.type === 'LEFT_VIDEO') {
    releaseVideo(tabId);
  } else if (msg?.type === 'PLAYHEAD') {
    // Viewer seeked or kept watching — re-aim the work at their new position.
    const job = jobs.get(tabsWatching.get(tabId));
    if (job && Number.isFinite(msg.time)) job.playhead = msg.time;
  }
});
