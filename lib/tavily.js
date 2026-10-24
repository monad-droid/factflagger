// Tavily search helper. Used only by the background worker.
// Docs: POST https://api.tavily.com/search, "basic" depth = 1 API credit per search.

const TAVILY_BASE = 'https://api.tavily.com';

class TavilyError extends Error {
  constructor(message, status, fatal) {
    super(message);
    this.status = status;
    this.fatal = fatal; // true = stop all checking (bad key, monthly limit)
  }
}

async function tavilySearch({ apiKey, query, maxResults, onWait }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${TAVILY_BASE}/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: query.slice(0, 400),
        search_depth: 'basic',
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        include_published_date: true
      })
    });
    if (res.status === 429) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 120);
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 401) throw new TavilyError('Tavily rejected the API key — check Settings.', 401, true);
    if (res.status === 432 || res.status === 433) {
      throw new TavilyError('Tavily monthly free limit reached — checking paused.', res.status, true);
    }
    if (!res.ok) throw new TavilyError(`Tavily HTTP ${res.status}`, res.status, false);
    const data = await res.json();
    return (data.results || []).map((r) => ({
      title: r.title || '',
      url: r.url || '',
      content: (r.content || '').slice(0, 700),
      published: r.published_date || ''
    }));
  }
  throw new TavilyError('Tavily kept rate-limiting after several retries.', 429, false);
}

// Checks the key without spending a credit (the /usage endpoint is free).
async function tavilyUsage(apiKey) {
  const res = await fetch(`${TAVILY_BASE}/usage`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401) return { ok: false, error: 'Tavily rejected the API key (401).' };
  if (!res.ok) return { ok: false, error: `Tavily returned HTTP ${res.status}.` };
  const data = await res.json();
  return {
    ok: true,
    used: data.account?.plan_usage ?? data.key?.usage ?? null,
    limit: data.account?.plan_limit ?? data.key?.limit ?? null
  };
}
