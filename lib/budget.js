// FactFlag free-tier budget tracking. Used only by the background worker.
//
// What is exact vs. estimated:
// - Tavily credits: exact, from Tavily's free /usage endpoint (refreshed at most
//   every 10 minutes because that endpoint is rate-limited), plus a local count
//   of searches made since the last refresh.
// - Groq requests left today: exact, from the headers on Groq's last reply.
// - Groq tokens today: counted locally by FactFlag (Groq doesn't report daily
//   tokens), compared against Groq's documented 200K/day base limit.

const GROQ_DOC_TOKENS_PER_DAY = 200000;
const TAVILY_REFRESH_MS = 10 * 60 * 1000;

// Groq's daily limits are reported to reset at midnight UTC, so count by UTC day.
const todayKey = () => new Date().toISOString().slice(0, 10);

// Serialize read-modify-write updates so parallel calls can't overwrite each other.
let budgetChain = Promise.resolve();
function updateBudget(mutator) {
  budgetChain = budgetChain.then(async () => {
    const { budget } = await chrome.storage.local.get('budget');
    const b = budget || {};
    if (b.date !== todayKey()) {
      b.date = todayKey();
      b.groq = {};
      b.chatgpt = { requests: 0, tokens: 0 };
    }
    b.groq = b.groq || {};
    b.tavily = b.tavily || { used: null, limit: null, searchesSinceRefresh: 0, refreshedAt: 0 };
    mutator(b);
    await chrome.storage.local.set({ budget: b });
    updateBadge(b);
  }).catch((e) => console.warn('[FactFlag] budget update failed:', e.message));
  return budgetChain;
}

function recordGroqCall(model, usage, limits) {
  return updateBudget((b) => {
    const m = b.groq[model] || { requests: 0, tokens: 0 };
    m.requests += 1;
    // Cached prompt tokens don't count toward Groq's rate limits (per Groq's
    // prompt-caching docs), so leave them out.
    const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
    m.tokens += Math.max(0, (usage?.total_tokens || 0) - cached);
    if (limits?.requestsLeftToday !== null && limits?.requestsLeftToday !== undefined) {
      m.requestsLeftToday = limits.requestsLeftToday;
      m.requestsPerDay = limits.requestsPerDay;
      m.requestsResetIn = limits.requestsResetIn;
    }
    m.tokensPerDayDocumented = GROQ_DOC_TOKENS_PER_DAY;
    b.groq[model] = m;
  });
}

function recordChatGPTCall(usage) {
  return updateBudget((b) => {
    const c = b.chatgpt || { requests: 0, tokens: 0 };
    c.requests += 1;
    c.tokens += usage?.total_tokens || 0;
    b.chatgpt = c;
  });
}

function recordTavilySearch() {
  return updateBudget((b) => { b.tavily.searchesSinceRefresh += 1; });
}

function tavilyLeft(b) {
  const t = b?.tavily;
  if (!t || t.used === null || t.limit === null) return null;
  return Math.max(0, t.limit - t.used - (t.searchesSinceRefresh || 0));
}

function updateBadge(b) {
  const left = tavilyLeft(b);
  chrome.action.setBadgeText({ text: left === null ? '' : String(left) });
  chrome.action.setBadgeBackgroundColor({ color: left !== null && left < 50 ? '#c62828' : '#555555' });
  chrome.action.setTitle({
    title: left === null ? 'FactFlag' : `FactFlag — ${left} Tavily searches left this month`
  });
}

// Pull exact Tavily numbers. `force` skips the 10-minute throttle (settings page).
async function refreshTavilyUsage(apiKey, force) {
  if (!apiKey) return null;
  const { budget } = await chrome.storage.local.get('budget');
  const last = budget?.tavily?.refreshedAt || 0;
  if (!force && Date.now() - last < TAVILY_REFRESH_MS) return budget;
  const r = await tavilyUsage(apiKey);
  if (!r.ok) return budget;
  await updateBudget((b) => {
    b.tavily = { used: r.used, limit: r.limit, searchesSinceRefresh: 0, refreshedAt: Date.now() };
  });
  return (await chrome.storage.local.get('budget')).budget;
}

async function getBudget() {
  await budgetChain;
  const { budget } = await chrome.storage.local.get('budget');
  if (budget && budget.date !== todayKey()) budget.groq = {};
  return budget || null;
}
