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
}

async function save() {
  const values = { enabled: $('enabled').checked };
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
$('resetModels').addEventListener('click', () => {
  $('detectionModel').value = D.detectionModel;
  $('verdictModel').value = D.verdictModel;
  save();
});
$('enabled').addEventListener('change', save);
load();
