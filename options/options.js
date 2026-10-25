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
}

async function save() {
  const values = { enabled: $('enabled').checked, soundEnabled: $('soundEnabled').checked };
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
$('testSound').addEventListener('click', () => self.factflagDing());
load();
