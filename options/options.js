const D = self.FACTFLAG_DEFAULTS;
const FIELDS = ['groqApiKey', 'detectionModel', 'verdictModel', 'tavilyApiKey'];
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  $('status').textContent = text;
  $('status').className = kind || '';
}

const GLOW_FIELDS = ['glowFalse', 'glowMisleading', 'glowTrue', 'glowUnverifiable',
  'glowPopFalse', 'glowPopMisleading', 'glowPopTrue', 'glowPopUnverifiable'];

async function load() {
  const s = { ...D, ...(await chrome.storage.local.get(Object.keys(D))) };
  for (const f of FIELDS) $(f).value = s[f] || '';
  $('enabled').checked = !!s.enabled;
  $('soundEnabled').checked = !!s.soundEnabled;
  $('liveList').checked = !!s.liveList;
  $('autoOpenList').checked = !!s.autoOpenList;
  $('glowMode').checked = !!s.glowMode;
  $('alertTiming').value = s.alertTiming === 'start' ? 'start' : 'end';
  $('glowStrength').value = s.glowStrength;
  $('glowStrengthValue').textContent = `${s.glowStrength}%`;
  for (const k of GLOW_FIELDS) $(k).checked = !!s[k];
  $('glowKinds').hidden = !s.glowMode;
  $('provider').value = s.provider || 'chatgpt';
  updateProviderNote();
}

async function save() {
  const values = { enabled: $('enabled').checked, soundEnabled: $('soundEnabled').checked, liveList: $('liveList').checked, autoOpenList: $('autoOpenList').checked, glowMode: $('glowMode').checked, provider: $('provider').value };
  for (const k of GLOW_FIELDS) values[k] = $(k).checked;
  values.alertTiming = $('alertTiming').value;
  values.glowStrength = Number($('glowStrength').value);
  for (const f of FIELDS) values[f] = $(f).value.trim();
  if (!values.detectionModel) values.detectionModel = D.detectionModel;
  if (!values.verdictModel) values.verdictModel = D.verdictModel;
  await chrome.storage.local.set(values);
  await load();
  setStatus('Saved.', 'ok');
}

async function testGroq() {
  await save();
  setStatus('Testing Groq…');
  $('details').hidden = true;
  const r = await chrome.runtime.sendMessage({ type: 'TEST_GROQ' });
  if (!r?.ok) { setStatus(r?.error || 'Test failed.', 'err'); return; }
  const problems = [];
  if (!r.detectionModelFound) problems.push(`detection model "${r.detectionModel}" not found`);
  if (!r.verdictModelFound) problems.push(`verdict model "${r.verdictModel}" not found`);
  if (problems.length) {
    setStatus(`Key works, but ${problems.join(' and ')}. Available models are listed below.`, 'err');
    $('details').textContent = r.available.join('\n');
    $('details').hidden = false;
  } else {
    setStatus('Key works and both models are available.', 'ok');
  }
}

async function testTavily() {
  await save();
  setStatus('Testing Tavily…');
  $('details').hidden = true;
  const r = await chrome.runtime.sendMessage({ type: 'TEST_TAVILY' });
  if (!r?.ok) { setStatus(r?.error || 'Test failed.', 'err'); return; }
  const usage = r.used !== null && r.limit !== null
    ? ` ${r.used} of ${r.limit} search credits used this month (each claim checked uses 1).`
    : '';
  setStatus(`Tavily key works.${usage}`, 'ok');
}

// ---- ChatGPT plan ----
const cg = (type, extra) => chrome.runtime.sendMessage({ type, ...extra });

async function loadChatGPT() {
  const r = await cg('CHATGPT_STATUS');
  const st = r?.result || {};
  $('cgSignIn').hidden = st.signedIn;
  $('cgSignOut').hidden = !st.signedIn;
  $('cgModelRow').hidden = !(st.signedIn && st.planEnabled);
  if (!st.signedIn) {
    $('cgStatus').textContent = 'Not connected.';
    return;
  }
  $('cgStatus').textContent = st.planEnabled
    ? `Connected as ${st.email || 'your ChatGPT account'} — plan use allowed.`
    : `Signed in as ${st.email || 'your ChatGPT account'}, but plan use wasn't allowed. Sign out and sign in again, and allow it.`;
  if (!st.planEnabled) return;
  const m = await cg('CHATGPT_MODELS');
  if (!m?.ok) {
    $('cgStatus').textContent += ` (Couldn't list models: ${m?.error})`;
    return;
  }
  const fill = (select, current, fallback, which) => {
    select.textContent = '';
    for (const model of m.result) {
      const opt = document.createElement('option');
      opt.value = model.slug;
      opt.textContent = model.name;
      select.appendChild(opt);
    }
    if (current && m.result.some((x) => x.slug === current)) select.value = current;
    else if (fallback) {
      select.value = fallback.slug;
      return cg('CHATGPT_SET_MODEL', { model: fallback.slug, which });
    }
  };
  await fill($('cgModel'), st.model, m.result[0], 'model');
  // Default claim finding to the first "Luna" model listed (the cheapest tier).
  const luna = m.result.find((x) => /luna/i.test(`${x.slug} ${x.name}`)) || m.result[0];
  await fill($('cgFastModel'), st.fastModel, luna, 'fastModel');
}

$('cgSignIn').addEventListener('click', async () => {
  $('cgStatus').textContent = 'A ChatGPT sign-in tab opened — finish there, then come back here.';
  const r = await cg('CHATGPT_SIGN_IN');
  if (!r?.ok) $('cgStatus').textContent = `Sign-in failed: ${r?.error}`;
  await loadChatGPT();
  if (!r?.ok) $('cgStatus').textContent = `Sign-in failed: ${r?.error}`;
});
$('cgSignOut').addEventListener('click', async () => {
  const r = await cg('CHATGPT_SIGN_OUT');
  await loadChatGPT();
  if (r?.ok && !r.result.revoked) {
    $('cgStatus').textContent += ' (Couldn\'t confirm sign-out with OpenAI — you can disconnect FactFlag in ChatGPT settings.)';
  }
});
$('cgModel').addEventListener('change', () => cg('CHATGPT_SET_MODEL', { model: $('cgModel').value }));
$('cgFastModel').addEventListener('change', () =>
  cg('CHATGPT_SET_MODEL', { model: $('cgFastModel').value, which: 'fastModel' }));
$('cgTest').addEventListener('click', async () => {
  const out = $('cgResult');
  out.hidden = false;
  out.textContent = 'Running one fact-check on your ChatGPT plan…';
  const r = await cg('CHATGPT_TEST');
  if (!r?.ok) { out.textContent = `Test failed: ${r?.error}`; return; }
  const t = r.result;
  out.textContent = [
    `Model: ${t.model}`,
    `Time: ${t.seconds} s`,
    `Web search allowed: ${t.webSearchAllowed ? 'yes' : `NO — ${t.webSearchError}`}`,
    `Web searches made: ${t.webSearchesMade}`,
    '',
    `Claim: ${t.claim}`,
    t.verdict ? `Verdict: ${t.verdict.verdict}` : `Raw answer: ${t.rawText}`,
    t.verdict ? `Why: ${t.verdict.explanation}` : '',
    t.verdict ? `Source says: "${t.verdict.evidence_quote}"` : '',
    t.verdict ? `Source: ${t.verdict.source_url}` : '',
    t.verdict ? `Source was among the pages the search returned: ${t.sourceFound ? 'yes' : 'NO'}` : '',
    '',
    `Pages found by the search (${t.citations.length}):`,
    ...t.citations.map((c) => `  ${c.url}`)
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
});
loadChatGPT();

// ---- Free budget meter ----
function meter(label, left, total, detail) {
  const wrap = document.createElement('div');
  wrap.className = 'meter';
  const row = document.createElement('div');
  row.className = 'meter-label';
  const a = document.createElement('span');
  a.textContent = label;
  const b = document.createElement('span');
  b.textContent = detail;
  row.append(a, b);
  wrap.appendChild(row);
  if (Number.isFinite(left) && Number.isFinite(total) && total > 0) {
    const bar = document.createElement('div');
    bar.className = 'meter-bar';
    const fill = document.createElement('div');
    const frac = Math.max(0, Math.min(1, left / total));
    fill.className = `meter-fill${frac < 0.1 ? ' low' : ''}`;
    fill.style.width = `${frac * 100}%`;
    bar.appendChild(fill);
    wrap.appendChild(bar);
  }
  return wrap;
}

const fmt = (n) => Number(n).toLocaleString();

// OpenAI's credit rates per 1M tokens (input, cached input, output), from
// developers.openai.com/codex/pricing. Used only to compare steps with each
// other; OpenAI says included plan usage isn't set by these rates alone.
const CREDIT_RATES = {
  gpt61sol: [50, 2.5, 250], gpt6sol: [50, 5, 250], gpt6astra: [250, 25, 1250], gpt6luna: [2.5, 0.25, 12.5],
  gpt56sol: [100, 10, 500], gpt56terra: [50, 5, 300], gpt56luna: [5, 0.5, 30]
};
const STEP_NAMES = { claims: 'Finding claims', triage: 'Screening', evidence: 'Web search', verdict: 'Verdicts', contradiction: 'Second check' };

function chatgptBreakdown(steps) {
  const credits = (x) => {
    const r = CREDIT_RATES[String(x.model).toLowerCase().replace(/[^a-z0-9]/g, '')];
    if (!r) return NaN;
    return ((x.input - x.cached) * r[0] + x.cached * r[1] + x.output * r[2]) / 1e6;
  };
  const rows = steps.map((x) => ({ ...x, credits: credits(x) }));
  const total = rows.reduce((t, x) => t + (Number.isFinite(x.credits) ? x.credits : 0), 0);
  const table = document.createElement('table');
  table.className = 'steps';
  const head = table.insertRow();
  for (const h of ['Step', 'Model', 'Requests', 'Web searches', 'Tokens in (cached) / out', 'Share of usage (est.)']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  rows.sort((a, b) => (b.credits || 0) - (a.credits || 0));
  for (const x of rows) {
    const tr = table.insertRow();
    const share = Number.isFinite(x.credits) && total ? `${Math.round((x.credits / total) * 100)}%` : 'unknown model';
    for (const v of [STEP_NAMES[x.step] || x.step, x.model, fmt(x.requests), fmt(x.searches || 0),
      `${fmt(x.input)} (${fmt(x.cached)}) / ${fmt(x.output)}`, share]) {
      tr.insertCell().textContent = v;
    }
  }
  return table;
}

async function loadBudget() {
  const box = $('budget');
  const s = { ...D, ...(await chrome.storage.local.get(Object.keys(D))) };
  const { budget } = (await chrome.runtime.sendMessage({ type: 'GET_BUDGET' })) || {};
  box.textContent = '';

  if (budget?.chatgpt?.requests) {
    box.appendChild(meter('ChatGPT plan — requests by FactFlag today', NaN, NaN,
      `${fmt(budget.chatgpt.requests)} (your plan's remaining allowance is at chatgpt.com/settings/usage)`));
    const steps = Object.values(budget.chatgpt.steps || {});
    if (steps.length) box.appendChild(chatgptBreakdown(steps));
  }
  const t = budget?.tavily;
  if (t && t.used !== null && t.limit !== null) {
    const left = Math.max(0, t.limit - t.used - (t.searchesSinceRefresh || 0));
    box.appendChild(meter('Tavily searches left this month', left, t.limit,
      `${fmt(left)} of ${fmt(t.limit)}`));
  } else {
    box.appendChild(meter('Tavily searches left this month', NaN, NaN,
      s.tavilyApiKey ? 'unknown — click Test Tavily key' : 'add a Tavily key'));
  }

  const models = [
    ['Claim-finding model', s.detectionModel],
    ['Verdict model', s.verdictModel]
  ];
  for (const [role, model] of models) {
    const m = budget?.groq?.[model];
    if (!m) {
      box.appendChild(meter(`${role} (${model})`, NaN, NaN, 'not used yet today'));
      continue;
    }
    if (Number.isFinite(m.requestsLeftToday) && Number.isFinite(m.requestsPerDay)) {
      box.appendChild(meter(`${role} — requests left today`, m.requestsLeftToday, m.requestsPerDay,
        `${fmt(m.requestsLeftToday)} of ${fmt(m.requestsPerDay)}`));
    }
    const limit = m.tokensPerDayDocumented || 200000;
    box.appendChild(meter(`${role} — tokens left today (estimate)`, limit - m.tokens, limit,
      `~${fmt(Math.max(0, limit - m.tokens))} of ${fmt(limit)} · ${fmt(m.requests)} requests by FactFlag`));
  }
}

document.querySelectorAll('button.show').forEach((b) => {
  b.addEventListener('click', () => {
    const input = $(b.dataset.for);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    b.textContent = hidden ? 'Hide' : 'Show';
  });
});
$('save').addEventListener('click', save);
$('testGroq').addEventListener('click', testGroq);
$('testTavily').addEventListener('click', () => testTavily().then(loadBudget));
$('refreshBudget').addEventListener('click', loadBudget);
loadBudget();
$('resetModels').addEventListener('click', () => {
  $('detectionModel').value = D.detectionModel;
  $('verdictModel').value = D.verdictModel;
  save();
});
$('enabled').addEventListener('change', save);
$('soundEnabled').addEventListener('change', save);
$('liveList').addEventListener('change', save);
$('autoOpenList').addEventListener('change', save);
$('glowMode').addEventListener('change', save);
$('alertTiming').addEventListener('change', save);
// Glow strength: preview while dragging, save when let go.
function previewGlow() {
  const el = document.createElement('div');
  el.className = 'factflag-glow factflag-glow-false';
  const s = Number($('glowStrength').value);
  self.factflagApplyGlowStrength(el, s);
  $('glowPreview').replaceChildren(el);
  $('glowStrengthValue').textContent = `${s}%`;
}
$('glowStrength').addEventListener('input', previewGlow);
$('glowStrength').addEventListener('change', () => { previewGlow(); save(); });
for (const k of GLOW_FIELDS) $(k).addEventListener('change', save);
$('provider').addEventListener('change', () => { updateProviderNote(); save(); });

function updateProviderNote() {
  $('providerNote').textContent = $('provider').value === 'chatgpt'
    ? 'Every step (finding claims, screening, web search, verdicts) runs on your ChatGPT plan. The Groq and Tavily keys below are not used.'
    : 'Claims are checked with Groq (AI) and Tavily (web search) using the keys below.';
}
$('testSound').addEventListener('click', () => self.factflagDing());
load();

// ---- Ask to change a setting ----
async function askToChange() {
  const text = $('askText').value.trim();
  if (!text) return;
  const out = $('askResult');
  out.hidden = false;
  out.textContent = 'Working on it…';
  $('askGo').disabled = true;
  try {
    const r = await chrome.runtime.sendMessage({ type: 'CHANGE_SETTINGS', request: text });
    out.textContent = '';
    if (!r?.ok) { out.textContent = `Couldn't do that: ${r?.error || 'no answer'}`; return; }
    const { reply, changes, undo, skipped } = r.result;
    if (reply) out.appendChild(Object.assign(document.createElement('p'), { textContent: reply }));
    if (skipped.length) {
      out.appendChild(Object.assign(document.createElement('p'), { textContent: `Not changed (the AI gave a value that isn't allowed): ${skipped.join(', ')}` }));
    }
    if (changes.length) {
      const show = (v) => (v === true ? 'on' : v === false ? 'off' : String(v));
      const ul = document.createElement('ul');
      for (const c of changes) {
        ul.appendChild(Object.assign(document.createElement('li'), { textContent: `${c.label}: ${show(c.from)} → ${show(c.to)}` }));
      }
      out.appendChild(ul);
      const undoBtn = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Undo' });
      undoBtn.addEventListener('click', async () => {
        await chrome.storage.local.set(undo);
        await load();
        out.textContent = 'Undone.';
      });
      out.appendChild(undoBtn);
      $('askText').value = '';
      await load();
    } else if (!reply) {
      out.textContent = 'Nothing needed changing.';
    }
  } finally {
    $('askGo').disabled = false;
  }
}
$('askGo').addEventListener('click', askToChange);
$('askText').addEventListener('keydown', (e) => { if (e.key === 'Enter') askToChange(); });
