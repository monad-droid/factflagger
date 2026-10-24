// FactFlag background service worker.
// All calls to outside APIs (Groq, Tavily) happen here, never in the content script.
importScripts('shared/defaults.js');

const GROQ_BASE = 'https://api.groq.com/openai/v1';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

// Toolbar button opens settings for now (the side panel comes in phase 2).
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'TEST_GROQ') {
    testGroq().then(sendResponse);
    return true; // keep the channel open for the async reply
  }
});
