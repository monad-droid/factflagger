// FactFlag background service worker.
// All calls to outside APIs (Groq, Tavily) happen here, never in the content script.
importScripts('shared/defaults.js', 'prompts.js', 'lib/groq.js', 'lib/tavily.js', 'lib/budget.js');

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const CHUNK_SECONDS = 60;   // transcript is scanned for claims a minute at a time
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
const CONTEXT_AFTER_WORDS = 60;              // following words shown too (a set-up may be clarified next;
const CONTEXT_AFTER_MAX_SENTENCES = 8;       // counted in words because filler like "No, actually, no." is short)

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
  // Caption durations (especially auto-generated ones) often overlap the next
  // line, so a sentence ends no later than the next one starts.
  for (let i = 0; i + 1 < sentences.length; i++) {
    sentences[i].end = Math.max(sentences[i].start, Math.min(sentences[i].end, sentences[i + 1].start));
  }
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
    cur.lastIndex = i;
  });
  for (const c of chunks) {
    c.after = [];
    let words = 0;
    for (let j = c.lastIndex + 1; j < sentences.length; j++) {
      if (words >= CONTEXT_AFTER_WORDS || c.after.length >= CONTEXT_AFTER_MAX_SENTENCES) break;
      c.after.push(sentences[j]);
      words += sentences[j].text.split(/\s+/).length;
    }
  }
  return chunks;
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

// When the claim has been fully said: the end of the sentence it starts in, or
// of later sentences too if the speaker's quoted words run longer than that.
function claimEnd(chunk, firstSentence, quote) {
  const quoteWords = String(quote || '').split(/\s+/).filter((w) => w && w !== '...' && w !== '…').length;
  const i = chunk.sentences.indexOf(firstSentence);
  let end = firstSentence.end;
  let words = firstSentence.text.split(/\s+/).length;
  for (let j = i + 1; j < chunk.sentences.length && words < quoteWords; j++) {
    end = chunk.sentences[j].end;
    words += chunk.sentences[j].text.split(/\s+/).length;
  }
  return end;
}

// `concepts` is the running list of the speaker's own metaphors/characters
// (e.g. "Instant Gratification Monkey"), shared across chunks of one video.
async function detectClaimsInChunk(chunk, meta, settings, concepts, onWait) {
  const P = self.FACTFLAG_PROMPTS;
  const asLines = (list) => list.map((s) => `[${Math.floor(s.start)}] ${s.text}`).join('\n');
  const transcript = asLines(chunk.sentences);
  const context = chunk.context.length ? asLines(chunk.context) : '(start of video)';
  const after = chunk.after.length ? asLines(chunk.after) : '(end of video)';
  const { json, usage, limits } = await groqChatJson({
    apiKey: settings.groqApiKey,
    model: settings.detectionModel,
    system: fill(P.claimDetectionSystem, { MAX_CLAIMS: P.maxClaimsPerChunk }),
    user: fill(P.claimDetectionUser, {
      TITLE: meta.title || 'unknown',
      CHANNEL: meta.channel || 'unknown',
      RANGE: `${fmtTime(chunk.start)}–${fmtTime(chunk.end)}`,
      CONCEPTS: concepts.size ? [...concepts].join('; ') : '(none yet)',
      CONTEXT: context,
      AFTER: after,
      TRANSCRIPT: transcript
    }),
    schemaName: 'claims',
    schema: CLAIMS_SCHEMA,
    reasoningEffort: P.detectionReasoningEffort,
    onWait
  });
  recordGroqCall(settings.detectionModel, usage, limits);
  if (usage) {
    console.info(LOG, `chunk ${fmtTime(chunk.start)}: ${usage.total_tokens} tokens, ${usage.prompt_tokens_details?.cached_tokens || 0} cached ` +
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
        tEnd: claimEnd(chunk, line, c.quote),
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
    source_url: { type: 'string' },
    evidence_quote: { type: 'string' }
  },
  required: ['verdict', 'explanation', 'source_url', 'evidence_quote'],
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
  recordTavilySearch();
  if (!results.length) {
    return { verdict: 'UNVERIFIABLE', explanation: 'The web search returned no results.', sourceUrl: '', sourceTitle: '' };
  }
  const resultsText = results.map((r, i) =>
    `[${i + 1}] ${r.title}\nURL: ${r.url}${r.published ? `\nPublished: ${r.published}` : ''}\n${r.content}`
  ).join('\n\n');

  const { json, usage, limits } = await groqChatJson({
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
  recordGroqCall(settings.verdictModel, usage, limits);
  if (usage) {
    console.info(LOG, `verdict ${fmtTime(claim.t)}: ${usage.total_tokens} tokens, ${usage.prompt_tokens_details?.cached_tokens || 0} cached ` +
      `(prompt ${usage.prompt_tokens}, completion ${usage.completion_tokens})`);
  }

  let verdict = ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'].includes(json.verdict) ? json.verdict : 'UNVERIFIABLE';
  let explanation = String(json.explanation || '').trim();
  const evidenceQuote = String(json.evidence_quote || '').trim();
  // The source must be one of the search results — never a URL the model made up.
  const source = results.find((r) => r.url === String(json.source_url || '').trim());

  // A FALSE/MISLEADING verdict must be backed by a real, specific contradiction.
  if (verdict === 'FALSE' || verdict === 'MISLEADING') {
    const reason = falseVerdictProblem({ source, evidenceQuote, explanation });
    if (reason) {
      console.info(LOG, `verdict ${fmtTime(claim.t)}: ${verdict} downgraded to UNVERIFIABLE — ${reason}`);
      verdict = 'UNVERIFIABLE';
      explanation = `${explanation} (Not flagged: ${reason}.)`;
    }
  }
  return {
    verdict,
    explanation,
    evidenceQuote: verdict === 'UNVERIFIABLE' ? '' : evidenceQuote,
    sourceUrl: source?.url || '',
    sourceTitle: source?.title || ''
  };
}

const normalizeText = (s) => s.toLowerCase()
  .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/\s+/g, ' ').trim();

// "No evidence" is not the same as "shown to be false".
const ABSENCE_OF_EVIDENCE = /\b(no evidence|unsubstantiated|unproven|lacks? evidence|not supported by evidence|could not (be )?(verify|verified|confirm)|insufficient evidence|no (reliable|credible) (source|data))\b/i;

// Returns why a FALSE/MISLEADING verdict can't be trusted, or '' if it's fine.
function falseVerdictProblem({ source, evidenceQuote, explanation }) {
  if (!source) return 'its source URL was not one of the search results';
  if (ABSENCE_OF_EVIDENCE.test(explanation)) return 'the evidence only says the claim is unproven, not that it is false';
  const quote = normalizeText(evidenceQuote.replace(/^["“]|["”]$/g, ''));
  if (quote.length < 20) return 'no supporting quote from the source';
  // Allow the model to trim with "..." — every piece must appear in the source text.
  const sourceText = normalizeText(`${source.title} ${source.content}`);
  const pieces = quote.split(/\s*(?:\.\.\.|…)\s*/).filter((p) => p.length >= 8);
  if (!pieces.length || !pieces.every((p) => sourceText.includes(p))) {
    return 'its quote does not appear in the source';
  }
  return '';
}

// Errors that should stop all checking for this video rather than skip one item.
function isFatal(e) {
  return e?.fatal === true || e?.status === 401;
}

// ---------------------------------------------------------------------------
// Triage: decide which claims are worth a (scarce) web search.
// ---------------------------------------------------------------------------
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          assessment: { type: 'string', enum: ['likely_true', 'unsure', 'possibly_false'] },
          reason: { type: 'string' }
        },
        required: ['id', 'assessment', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['results'],
  additionalProperties: false
};

async function triageClaims(claims, meta, settings, onWait) {
  const P = self.FACTFLAG_PROMPTS;
  const list = claims
    .map((c) => `[${c.id}] (${fmtTime(c.t)}) ${c.claim}\n    Speaker's words: "${c.quote}"`)
    .join('\n');
  const { json, usage, limits } = await groqChatJson({
    apiKey: settings.groqApiKey,
    model: settings.verdictModel,
    system: P.triageSystem,
    user: fill(P.triageUser, {
      TITLE: meta.title || 'unknown',
      PUBLISHED: meta.published || 'unknown',
      CLAIMS: list
    }),
    schemaName: 'triage',
    schema: TRIAGE_SCHEMA,
    reasoningEffort: P.triageReasoningEffort,
    onWait
  });
  recordGroqCall(settings.verdictModel, usage, limits);

  const byId = new Map((Array.isArray(json.results) ? json.results : []).map((r) => [Number(r.id), r]));
  for (const c of claims) {
    const r = byId.get(c.id);
    // Anything missing or malformed counts as "unsure" — it still gets searched.
    const a = ['likely_true', 'unsure', 'possibly_false'].includes(r?.assessment) ? r.assessment : 'unsure';
    c.triage = a;
    c.triageReason = String(r?.reason || '').trim();
    if (a === 'likely_true') c.status = 'skipped';
  }
  const skipped = claims.filter((c) => c.status === 'skipped').length;
  console.info(LOG, `triage: ${skipped} of ${claims.length} claim(s) judged likely true — not searched`);
}

// ---------------------------------------------------------------------------
// Just-in-time checking.
// Only work on what's within checkAheadSeconds (prompts.js) of where the viewer is
// listening (scaled up at faster playback speeds). Videos you abandon cost only
// what you heard plus that window. Progress is saved after every step so the
// work resumes exactly where it left off if the service worker goes to sleep.
// ---------------------------------------------------------------------------
const BEHIND_SLACK_SECONDS = 15; // a claim that started a moment ago is still being heard
const MIN_LEAD_SECONDS = 10;     // a verdict ready with less time to spare than this is "too close"
const LEAD_STEP_SECONDS = 15;    // how much to widen the window when that happens
const STATE_VERSION = 4; // bump when the saved format, chunking or prompts change

const videoKey = (videoId) => `video:${videoId}`;
const transcriptKey = (videoId) => `transcript:${videoId}`;
const tabsWatching = new Map(); // tabId -> videoId
const jobs = new Map();         // videoId -> in-memory job (rebuilt from storage when needed)

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

// The worker is shut down after ~30s without extension activity. Keep it awake
// only while a job is actually working (including waiting out a rate limit);
// an idle job is rebuilt from storage on the next playhead update.
let keepAliveTimer = null;
function updateKeepAlive() {
  const busy = [...jobs.values()].some((j) => j.busy);
  if (busy && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  } else if (!busy && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

function newState(videoId, meta, chunkCount) {
  return {
    version: STATE_VERSION,
    videoId,
    title: meta.title || '',
    status: 'working',      // working | idle | done | error
    chunksTotal: chunkCount,
    chunksDone: [],         // indexes of chunks already scanned for claims
    claims: [],
    concepts: [],           // the speaker's own metaphors/characters
    nextId: 1,
    note: '',
    error: ''
  };
}

function lookaheadSeconds(job) {
  const base = Number(self.FACTFLAG_PROMPTS.checkAheadSeconds) || 75;
  return Math.min(base * 2, base + (job.extraAhead || 0));
}

function windowFor(job) {
  const ahead = lookaheadSeconds(job) * Math.max(1, job.rate || 1);
  return { from: job.playhead - BEHIND_SLACK_SECONDS, to: job.playhead + ahead };
}

// The earliest thing inside the window: scanning a chunk for claims, or
// checking a claim. On a tie the chunk goes first (it may hold earlier claims).
function nextWork(job) {
  const { from, to } = windowFor(job);
  let best = null;
  let bestTime = Infinity;
  job.chunks.forEach((c, index) => {
    if (job.state.chunksDone.includes(index) || c.end < from || c.start > to) return;
    const time = Math.max(c.start, from);
    if (time < bestTime) { bestTime = time; best = { kind: 'chunk', index }; }
  });
  for (const claim of job.state.claims) {
    if (claim.status !== 'pending' || claim.t < from || claim.t > to) continue;
    if (claim.t < bestTime) { bestTime = claim.t; best = { kind: 'claim', claim }; }
  }
  return best;
}

function everythingDone(job) {
  return job.state.chunksDone.length >= job.chunks.length &&
    !job.state.claims.some((c) => c.status === 'pending' || c.status === 'checking');
}

async function processChunk(job, index, settings, onWait) {
  const { state } = job;
  const found = await detectClaimsInChunk(job.chunks[index], job.meta, settings, job.concepts, onWait);
  state.concepts = [...job.concepts];
  if (job.concepts.size) console.info(LOG, `speaker's own concepts so far: ${state.concepts.join('; ')}`);
  const claims = found.map((c) => ({ id: state.nextId++, status: 'pending', ...c }));

  if (claims.length && self.FACTFLAG_PROMPTS.triageEnabled) {
    try {
      await triageClaims(claims, job.meta, settings, onWait);
    } catch (e) {
      if (isFatal(e)) throw e;
      // If triage fails, search everything rather than risk missing something.
      console.warn(LOG, `triage failed (${e.message}) — all claims in this section will be searched`);
    }
  }
  if (job.cancelled) return;
  state.claims.push(...claims);
  state.claims.sort((a, b) => a.t - b.t);
  state.chunksDone.push(index);
}

async function processClaim(job, claim, settings, onWait) {
  claim.status = 'checking';
  const startLead = (claim.t - job.playhead) / Math.max(1, job.rate || 1);
  try {
    const result = await verifyClaim(claim, job.meta, settings, onWait);
    if (job.cancelled) { claim.status = 'pending'; return; }
    Object.assign(claim, result, { status: 'done' });
    // How far ahead of the viewer was this verdict ready (in seconds of video)?
    const lead = (claim.t - job.playhead) / Math.max(1, job.rate || 1);
    console.info(LOG, `${fmtTime(claim.t)} ${claim.verdict} (ready ${Math.round(lead)}s before it's said): ${claim.claim}`);
    // Only widen if we started with enough time and still cut it close — not
    // when the viewer simply skipped to right before (or past) the claim.
    if (startLead >= MIN_LEAD_SECONDS * 2 && lead < MIN_LEAD_SECONDS) {
      const before = lookaheadSeconds(job);
      job.extraAhead = (job.extraAhead || 0) + LEAD_STEP_SECONDS;
      if (lookaheadSeconds(job) > before) {
        console.info(LOG, `verdict was nearly late — checking further ahead (${lookaheadSeconds(job)}s) for this video`);
      }
    }
  } catch (e) {
    if (isFatal(e)) { claim.status = 'pending'; throw e; }
    console.warn(LOG, `Could not check claim at ${fmtTime(claim.t)}: ${e.message}`);
    Object.assign(claim, { status: 'error', error: e.message });
  }
}

async function runJob(job) {
  const { state } = job;
  const chunkFailures = new Map();
  const onWait = (secs) => {
    state.note = `rate limit — waiting ${secs}s`;
    saveState(state);
  };
  try {
    const settings = await getSettings();
    if (!settings.groqApiKey) throw Object.assign(new Error('Add your Groq API key in FactFlag settings.'), { fatal: true });
    if (!settings.tavilyApiKey) throw Object.assign(new Error('Add your Tavily API key in FactFlag settings.'), { fatal: true });
    refreshTavilyUsage(settings.tavilyApiKey, false).catch(() => {});

    while (!job.cancelled) {
      const work = nextWork(job);
      if (!work) {
        const settled = everythingDone(job) ? 'done' : 'idle';
        if (state.status !== settled || state.note) {
          state.status = settled;
          state.note = '';
          await saveState(state);
        }
        if (state.status === 'done') {
          const falseCount = state.claims.filter((c) => c.verdict === 'FALSE').length;
          console.info(LOG, `Finished ${job.videoId}: ${state.claims.length} claims, ${falseCount} false.`);
          break;
        }
        // Nothing to do near the viewer — wait for them to keep watching or seek.
        job.busy = false;
        updateKeepAlive();
        await new Promise((resolve) => { job.wake = resolve; });
        job.wake = null;
        continue;
      }

      job.busy = true;
      updateKeepAlive();
      if (state.status !== 'working') {
        state.status = 'working';
        await saveState(state);
      }
      if (work.kind === 'chunk') {
        try {
          await processChunk(job, work.index, settings, onWait);
        } catch (e) {
          if (isFatal(e)) throw e;
          const fails = (chunkFailures.get(work.index) || 0) + 1;
          chunkFailures.set(work.index, fails);
          console.warn(LOG, `Scanning section ${work.index + 1} failed (${e.message})${fails >= 2 ? ' — skipping it' : ' — will retry'}`);
          if (fails >= 2) state.chunksDone.push(work.index);
          else await new Promise((r) => setTimeout(r, 5000));
        }
      } else {
        await processClaim(job, work.claim, settings, onWait);
      }
      if (job.cancelled) break;
      state.note = '';
      await saveState(state);
    }
  } catch (e) {
    console.error(LOG, `Checking stopped for ${job.videoId}:`, e.message);
    state.status = 'error';
    state.error = e.message;
    state.note = '';
    await saveState(state);
  } finally {
    job.busy = false;
    if (jobs.get(job.videoId) === job) jobs.delete(job.videoId);
    updateKeepAlive();
  }
}

// Start (or resume, or re-aim) checking for a video. Safe to call repeatedly.
async function ensureJob(videoId, { playhead, rate, segments, meta }) {
  const fromTranscript = Array.isArray(segments); // a page (re)load, not a playhead update
  const existing = jobs.get(videoId);
  if (existing) {
    if (Number.isFinite(playhead)) existing.playhead = playhead;
    if (Number.isFinite(rate)) existing.rate = rate;
    existing.wake?.();
    return;
  }
  // Register synchronously so a second message can't start a duplicate job.
  const job = {
    videoId, cancelled: false, busy: false, wake: null,
    playhead: Number.isFinite(playhead) ? playhead : 0,
    rate: Number.isFinite(rate) ? rate : 1
  };
  jobs.set(videoId, job);
  try {
    const settings = await getSettings();
    if (!settings.enabled) { jobs.delete(videoId); return; }

    if (segments) {
      await chrome.storage.session.set({ [transcriptKey(videoId)]: { segments, meta } });
    } else {
      const saved = (await chrome.storage.session.get(transcriptKey(videoId)))[transcriptKey(videoId)];
      if (!saved) { jobs.delete(videoId); return; } // transcript not loaded yet
      segments = saved.segments;
      meta = saved.meta;
    }

    const chunks = makeChunks(segments);
    let state = await loadState(videoId);
    if (!state || state.version !== STATE_VERSION || state.chunksTotal !== chunks.length) {
      state = newState(videoId, meta, chunks.length);
    }
    if (state.status === 'done') {
      jobs.delete(videoId);
      await saveState(state); // re-send results to the tab
      return;
    }
    // After a stopping error (daily/monthly limit, bad key) only retry when the
    // page is reloaded — not on every playhead update, which would hammer the API.
    if (state.status === 'error' && !fromTranscript) {
      jobs.delete(videoId);
      return;
    }
    // Resuming: anything interrupted mid-check goes back in the queue.
    for (const c of state.claims) if (c.status === 'checking') c.status = 'pending';
    state.status = 'working';
    state.error = '';
    state.note = '';

    Object.assign(job, { state, chunks, meta, concepts: new Set(state.concepts || []) });
    if (job.cancelled) return;
    await saveState(state);
    runJob(job);
  } catch (e) {
    console.error(LOG, `Could not start checking ${videoId}:`, e.message);
    if (jobs.get(videoId) === job) jobs.delete(videoId);
  }
}

// Stop work for a video nobody is watching any more. Results are kept, so
// coming back to it resumes where it left off.
function releaseVideo(tabId) {
  const old = tabsWatching.get(tabId);
  tabsWatching.delete(tabId);
  if (!old || [...tabsWatching.values()].includes(old)) return;
  const job = jobs.get(old);
  if (job) {
    job.cancelled = true;
    job.wake?.();
    jobs.delete(old);
    updateKeepAlive();
  }
}

function watch(tabId, videoId) {
  if (tabsWatching.get(tabId) !== videoId) releaseVideo(tabId);
  tabsWatching.set(tabId, videoId);
}

chrome.tabs.onRemoved.addListener((tabId) => releaseVideo(tabId));
// A full page load (reload, or leaving YouTube in this tab) ends that page's
// content script; if it's still a YouTube video it will report back in.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && tabsWatching.has(tabId) && changeInfo.url === undefined) {
    releaseVideo(tabId);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'TEST_GROQ') {
    testGroq().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
  if (msg?.type === 'TEST_TAVILY') {
    getSettings()
      .then(async (s) => {
        if (!s.tavilyApiKey) return { ok: false, error: 'No Tavily API key saved yet.' };
        const r = await tavilyUsage(s.tavilyApiKey);
        if (r.ok) await refreshTavilyUsage(s.tavilyApiKey, true);
        return r;
      })
      .catch((e) => ({ ok: false, error: `Network error: ${e.message}` }))
      .then(sendResponse);
    return true;
  }
  if (msg?.type === 'GET_BUDGET') {
    getSettings()
      .then((s) => refreshTavilyUsage(s.tavilyApiKey, false).catch(() => null))
      .then(() => getBudget())
      .then((budget) => sendResponse({ budget }));
    return true;
  }

  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  if (msg?.type === 'TRANSCRIPT') {
    watch(tabId, msg.videoId);
    ensureJob(msg.videoId, {
      playhead: msg.playhead,
      rate: msg.rate,
      segments: msg.segments,
      meta: { title: msg.title, channel: msg.channel, published: msg.published }
    });
  } else if (msg?.type === 'PLAYHEAD') {
    // Viewer is playing or seeked — re-aim the work at their position.
    if (!msg.videoId) return;
    watch(tabId, msg.videoId);
    ensureJob(msg.videoId, { playhead: msg.time, rate: msg.rate });
  } else if (msg?.type === 'LEFT_VIDEO') {
    releaseVideo(tabId);
  }
});
