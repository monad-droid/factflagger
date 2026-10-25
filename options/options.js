const D = self.FACTFLAG_DEFAULTS;
const FIELDS = ['groqApiKey', 'detectionModel', 'verdictModel', 'tavilyApiKey'];
const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  $('status').textContent = text;
  $('status').className = kind || '';
}

async function load() {
  const s = { ...D, ...(await chrome.storage.local.get(Object.keys(D))) };
  for (const f of FIELDS) $(f).value = s[f] || '';
  $('enabled').checked = !!s.enabled;
  $('soundEnabled').checked = !!s.soundEnabled;
  $('provider').value = s.provider || 'chatgpt';
  updateProviderNote();
}

async function save() {
  const values = { enabled: $('enabled').checked, soundEnabled: $('soundEnabled').checked, provider: $('provider').value };
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
  const select = $('cgModel');
  select.textContent = '';
  if (!m?.ok) {
    $('cgStatus').textContent += ` (Couldn't list models: ${m?.error})`;
    return;
  }
  for (const model of m.result) {
    const opt = document.createElement('option');
    opt.value = model.slug;
    opt.textContent = model.name;
    select.appendChild(opt);
  }
  if (st.model && m.result.some((x) => x.slug === st.model)) select.value = st.model;
  else if (m.result[0]) await cg('CHATGPT_SET_MODEL', { model: m.result[0].slug });
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

async function loadBudget() {
  const box = $('budget');
  const s = { ...D, ...(await chrome.storage.local.get(Object.keys(D))) };
  const { budget } = (await chrome.runtime.sendMessage({ type: 'GET_BUDGET' })) || {};
  box.textContent = '';

  if (budget?.chatgpt?.requests) {
    box.appendChild(meter('ChatGPT plan — requests by FactFlag today', NaN, NaN,
      `${fmt(budget.chatgpt.requests)} (your plan's remaining allowance is at chatgpt.com/settings/usage)`));
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
$('provider').addEventListener('change', () => { updateProviderNote(); save(); });

function updateProviderNote() {
  $('providerNote').textContent = $('provider').value === 'chatgpt'
    ? 'Every step (finding claims, screening, web search, verdicts) runs on your ChatGPT plan. The Groq and Tavily keys below are not used.'
    : 'Claims are checked with Groq (AI) and Tavily (web search) using the keys below.';
}
$('testSound').addEventListener('click', () => self.factflagDing());
load();
