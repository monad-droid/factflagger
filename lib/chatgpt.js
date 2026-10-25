// "Sign in with ChatGPT" — use the viewer's own ChatGPT plan (Plus/Pro) for
// AI requests instead of paying per token. Used only by the background worker.
//
// Follows OpenAI's open-source flow (developers.openai.com/siwc):
// - first sign-in registers FactFlag with client_id=dynamic_agent_client and
//   gets back an issued client_id; later sign-ins reuse it
// - OAuth with PKCE; the redirect must be an http://127.0.0.1 loopback URL.
//   A browser extension can't run a local web server, so we watch the sign-in
//   tab and read the code from that URL as the browser navigates to it
//   (nothing ever needs to answer on that port).
// - requests go to POST https://api.openai.com/v1/responses with
//   store:false and stream:true
// - plan errors stop the request; OpenAI never switches to paid billing.
//
// Tokens are kept in chrome.storage.local (private to this extension) and are
// never logged.

const CG = {
  authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
  tokenUrl: 'https://auth.openai.com/api/accounts/oauth/token',
  discoveryUrl: 'https://auth.openai.com/.well-known/openid-configuration',
  issuer: 'https://auth.openai.com',
  resource: 'https://api.openai.com/v1',
  apiBase: 'https://api.openai.com/v1',
  redirectUri: 'http://127.0.0.1:47815/auth/callback',
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  planScope: 'chatgpt.tokens.use.direct',
  appName: 'FactFlag',
  storageKey: 'chatgptAuth'
};

class ChatGPTError extends Error {
  constructor(message, { status, code, fatal } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fatal = !!fatal;
  }
}

// ---------- small helpers ----------
function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const randomString = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256(text) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
}

async function loadAuth() {
  return (await chrome.storage.local.get(CG.storageKey))[CG.storageKey] || {};
}
async function saveAuth(auth) {
  await chrome.storage.local.set({ [CG.storageKey]: auth });
}

// A stable, opaque ID for this browser install (OpenAI's "host ID").
async function hostId() {
  const auth = await loadAuth();
  if (auth.hostId) return auth.hostId;
  auth.hostId = `urn:uuid:${crypto.randomUUID()}`;
  await saveAuth(auth);
  return auth.hostId;
}

// ---------- ID token validation ----------
let discoveryCache = null;
async function discovery() {
  if (!discoveryCache) {
    const res = await fetch(CG.discoveryUrl);
    if (!res.ok) throw new ChatGPTError(`OpenAI sign-in configuration unavailable (HTTP ${res.status}).`);
    discoveryCache = await res.json();
  }
  return discoveryCache;
}

async function verifyIdToken(idToken, clientId, nonce) {
  const [h, p, sig] = String(idToken || '').split('.');
  if (!h || !p || !sig) throw new ChatGPTError('Sign-in returned an invalid ID token.');
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));

  // Signature against OpenAI's published keys.
  const { jwks_uri: jwksUri } = await discovery();
  const jwks = await (await fetch(jwksUri)).json();
  const jwk = (jwks.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) throw new ChatGPTError('Could not find the key that signed the ID token.');
  let algo;
  if (header.alg === 'RS256') algo = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  else if (header.alg === 'ES256') algo = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  else throw new ChatGPTError(`Unsupported ID token algorithm ${header.alg}.`);
  const key = await crypto.subtle.importKey('jwk', jwk, algo, false, ['verify']);
  const ok = await crypto.subtle.verify(algo, key, b64urlDecode(sig), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new ChatGPTError('ID token signature is invalid.');

  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== CG.issuer) throw new ChatGPTError('ID token has the wrong issuer.');
  if (!aud.includes(clientId)) throw new ChatGPTError('ID token was issued for a different app.');
  if (!payload.exp || payload.exp * 1000 < Date.now() - 60000) throw new ChatGPTError('ID token has expired.');
  if (payload.nonce !== nonce) throw new ChatGPTError('ID token nonce does not match this sign-in.');
  return payload;
}

// ---------- sign-in ----------
let pendingSignIn = null; // only one at a time

function waitForCallback(tabId) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      fn(value);
    };
    const onUpdated = (id, changeInfo) => {
      const url = changeInfo.url;
      if (id !== tabId || !url || !url.startsWith(CG.redirectUri)) return;
      chrome.tabs.remove(tabId).catch(() => {});
      done(resolve, new URL(url));
    };
    const onRemoved = (id) => {
      if (id === tabId) done(reject, new ChatGPTError('Sign-in window was closed before finishing.'));
    };
    const timer = setTimeout(() => done(reject, new ChatGPTError('Sign-in timed out.')), 10 * 60 * 1000);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

async function chatgptSignIn() {
  if (pendingSignIn) throw new ChatGPTError('A ChatGPT sign-in is already in progress.');
  // Keep the worker awake while the user signs in (can take minutes).
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  pendingSignIn = true;
  try {
    const auth = await loadAuth();
    const host = await hostId();
    const returning = !!auth.clientId;
    const state = randomString();
    const nonce = randomString();
    const verifier = randomString(48);
    const challenge = b64url(await sha256(verifier));

    const params = new URLSearchParams({
      client_id: returning ? auth.clientId : 'dynamic_agent_client',
      ext_agent_host_id: host,
      response_type: 'code',
      redirect_uri: CG.redirectUri,
      scope: CG.scope,
      resource: CG.resource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge
    });
    if (returning) {
      if (auth.idToken) params.set('id_token_hint', auth.idToken);
      if (auth.email) params.set('login_hint', auth.email);
    } else {
      params.set('agent_name_hint', CG.appName);
    }

    const tab = await chrome.tabs.create({ url: `${CG.authorizeUrl}?${params}` });
    const cb = await waitForCallback(tab.id);

    if (cb.searchParams.get('state') !== state) throw new ChatGPTError('Sign-in response did not match (state).');
    const oauthError = cb.searchParams.get('error');
    if (oauthError === 'access_denied') throw new ChatGPTError('You declined access, so FactFlag can\'t use your ChatGPT plan.');
    if (oauthError) throw new ChatGPTError(`Sign-in failed: ${oauthError}`);
    const code = cb.searchParams.get('code');
    const cbClientId = cb.searchParams.get('client_id');
    if (returning && cbClientId && cbClientId !== auth.clientId) {
      throw new ChatGPTError('Sign-in returned a different app registration; not replacing the saved one.');
    }
    const clientId = returning ? auth.clientId : cbClientId;
    if (!code || !clientId) throw new ChatGPTError('Sign-in did not complete registration (no code or client ID).');

    const tokenRes = await fetch(CG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: CG.redirectUri,
        resource: CG.resource
      })
    });
    const tokens = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new ChatGPTError(`Token exchange failed: ${tokens.error || `HTTP ${tokenRes.status}`}`);

    const claims = await verifyIdToken(tokens.id_token, clientId, nonce);
    if (returning && auth.subject && claims.sub !== auth.subject) {
      throw new ChatGPTError('Signed in to a different ChatGPT account than the saved one.');
    }
    const scopes = String(tokens.scope || '').split(/\s+/).filter(Boolean);
    const next = {
      hostId: host,
      clientId,
      subject: claims.sub,
      email: claims.email || auth.email || '',
      idToken: tokens.id_token,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (Number(tokens.expires_in) || 3600) * 1000,
      scopes,
      planEnabled: scopes.includes(CG.planScope),
      model: auth.model || '',
      fastModel: auth.fastModel || ''
    };
    await saveAuth(next);
    return chatgptStatus();
  } finally {
    pendingSignIn = null;
    clearInterval(keepAlive);
  }
}

// ---------- tokens ----------
let refreshing = null;
async function accessToken() {
  const auth = await loadAuth();
  if (!auth.accessToken) throw new ChatGPTError('Not signed in to ChatGPT.', { fatal: true });
  if (!auth.planEnabled) {
    throw new ChatGPTError('ChatGPT plan use wasn\'t allowed during sign-in — sign in again and allow it.', { fatal: true });
  }
  if (auth.expiresAt - Date.now() > 5 * 60 * 1000) return auth.accessToken;
  // Refresh once at a time: refresh tokens rotate.
  refreshing = refreshing || (async () => {
    const res = await fetch(CG.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: auth.clientId,
        refresh_token: auth.refreshToken,
        resource: CG.resource
      })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (/invalid_grant|refresh_token|token_expired/.test(body.error || '')) {
        await saveAuth({ ...auth, accessToken: '', refreshToken: '' });
        throw new ChatGPTError('Your ChatGPT sign-in expired — sign in again in FactFlag settings.', { fatal: true });
      }
      throw new ChatGPTError(`Couldn't renew ChatGPT access (${body.error || `HTTP ${res.status}`}).`);
    }
    const scopes = body.scope ? String(body.scope).split(/\s+/) : auth.scopes;
    await saveAuth({
      ...auth,
      accessToken: body.access_token,
      refreshToken: body.refresh_token || auth.refreshToken,
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      scopes,
      planEnabled: scopes.includes(CG.planScope)
    });
    return body.access_token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function chatgptStatus() {
  const auth = await loadAuth();
  return {
    signedIn: !!auth.accessToken,
    email: auth.email || '',
    planEnabled: !!auth.planEnabled,
    model: auth.model || '',
    fastModel: auth.fastModel || ''
  };
}

// which: 'model' = verdicts (and screening, second check); 'fastModel' = claim finding.
async function chatgptSetModel(model, which) {
  const auth = await loadAuth();
  await saveAuth({ ...auth, [which === 'fastModel' ? 'fastModel' : 'model']: model });
}

async function chatgptSignOut() {
  const auth = await loadAuth();
  let revoked = false;
  if (auth.refreshToken && auth.clientId) {
    try {
      const { revocation_endpoint: endpoint } = await discovery();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: auth.refreshToken, token_type_hint: 'refresh_token', client_id: auth.clientId })
      });
      revoked = res.ok;
    } catch (_) { /* fall through: clear locally anyway */ }
  }
  // Keep the app registration and host ID for a later sign-in.
  await saveAuth({ hostId: auth.hostId, clientId: auth.clientId, subject: auth.subject, email: auth.email, model: auth.model, fastModel: auth.fastModel });
  return { revoked };
}

// ---------- models ----------
async function chatgptModels() {
  const res = await fetch(`${CG.apiBase}/models`, { headers: { Authorization: `Bearer ${await accessToken()}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ChatGPTError(`Couldn't list models (${body.error?.code || body.detail || `HTTP ${res.status}`}).`);
  const list = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  return list
    .filter((m) => !m.visibility || m.visibility === 'list')
    .map((m) => ({ slug: m.slug || m.id, name: m.display_name || m.slug || m.id }));
}

// ---------- Responses API (streamed) ----------
// Returns { text, output, usage, ms, webSearches, citations }.
// Optional request settings the plan may refuse. Once one is refused it is
// left out for the rest of this session, so later requests aren't sent twice.
const OPTIONAL_PARAMS = [
  // Listing the pages a search returned (else they're taken from the answer's links).
  { key: 'include', match: /include/i },
  // Capping the number of searches per verdict.
  { key: 'max_tool_calls', match: /max_tool_calls/i },
  // Reading less text from each found page.
  { key: 'search_context_size', match: /search_context_size|tools/i },
  // Grouping requests that share instructions, so they hit OpenAI's cache.
  { key: 'prompt_cache_key', match: /prompt_cache_key/i }
];
const refusedParams = new Set();

async function chatgptRespond(args) {
  for (;;) {
    try {
      return await chatgptRespondOnce(args);
    } catch (e) {
      const unsupported = e.code === 'subscription_sharing_unsupported_capability' ||
        (e.status === 400 && /unknown|unsupported|unrecognized|not supported|invalid/i.test(e.message));
      const param = unsupported && OPTIONAL_PARAMS.find((p) =>
        !refusedParams.has(p.key) && p.match.test(`${e.param || ''} ${e.message}`) && sentParam(args, p.key));
      if (!param) throw e;
      refusedParams.add(param.key);
      console.warn(`[FactFlag] ChatGPT plan refused "${param.key}" — sending requests without it from now on.`);
    }
  }
}

function sentParam(args, key) {
  const search = args.tools?.some((t) => t.type === 'web_search');
  if (key === 'include') return search;
  if (key === 'max_tool_calls') return search && Number.isFinite(args.maxToolCalls);
  if (key === 'search_context_size') return args.tools?.some((t) => t.search_context_size);
  if (key === 'prompt_cache_key') return !!args.promptCacheKey;
  return false;
}

async function chatgptRespondOnce({ model, instructions, input, tools, toolChoice, textFormat, reasoningEffort, signal, maxToolCalls, promptCacheKey }) {
  const body = { model, instructions, input, store: false, stream: true };
  // Cached input costs a fraction of fresh input. Each step's instructions are
  // the same every time, so they can be cached when sent with the same key.
  if (promptCacheKey && !refusedParams.has('prompt_cache_key')) body.prompt_cache_key = promptCacheKey;
  if (tools?.length) {
    body.tools = refusedParams.has('search_context_size')
      ? tools.map(({ search_context_size, ...t }) => t)
      : tools;
  }
  const search = tools?.some((t) => t.type === 'web_search');
  // OpenAI only lists the pages a web search returned if asked for them.
  if (search && !refusedParams.has('include')) body.include = ['web_search_call.action.sources'];
  if (search && Number.isFinite(maxToolCalls) && !refusedParams.has('max_tool_calls')) body.max_tool_calls = maxToolCalls;
  if (toolChoice) body.tool_choice = toolChoice;
  if (textFormat) body.text = { format: textFormat };
  if (reasoningEffort) body.reasoning = { effort: reasoningEffort };

  const started = performance.now();
  const res = await fetch(`${CG.apiBase}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const code = err.error?.code || '';
    const param = err.error?.param || '';
    const message = err.error?.message || err.detail || `HTTP ${res.status}`;
    const planErr = chatgptPlanError(res.status, code, `${message}${param ? ` (param: ${param})` : ''}`);
    planErr.param = param;
    planErr.resetSeconds = resetSecondsFrom(res.headers, err);
    logUsageHeaders(res.headers, true);
    throw planErr;
  }
  logUsageHeaders(res.headers, false);

  // Parse the server-sent event stream.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = null;
  // Search calls and citations can arrive as their own stream events, so
  // collect them here as well as from the final response.
  const streamedItems = [];
  const streamedAnnotations = [];
  let searchEvents = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch (_) { continue; }
      if (ev.type === 'response.output_text.delta') text += ev.delta || '';
      else if (ev.type === 'response.output_item.done' && ev.item) streamedItems.push(ev.item);
      else if (ev.type === 'response.output_text.annotation.added' && ev.annotation) streamedAnnotations.push(ev.annotation);
      else if (ev.type === 'response.web_search_call.completed') searchEvents++;
      else if (ev.type === 'response.completed') completed = ev.response;
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        const e = ev.response?.error || ev.error || ev;
        throw chatgptPlanError(0, e.code || '', e.message || 'ChatGPT request failed');
      } else if (ev.type === 'response.incomplete') {
        throw new ChatGPTError(`ChatGPT response was incomplete (${ev.response?.incomplete_details?.reason || 'unknown reason'}).`);
      }
    }
  }
  if (!completed) throw new ChatGPTError('ChatGPT stream ended before the response completed.');

  const output = completed.output?.length ? completed.output : streamedItems;
  const searchItems = [...output, ...streamedItems].filter((o) => o.type === 'web_search_call');
  const webSearches = Math.max(new Set(searchItems.map((o) => o.id || Math.random())).size, searchEvents);
  // Every page the search returned or the answer cited.
  const seen = new Map();
  const addUrl = (url, title) => { if (url && !seen.has(url)) seen.set(url, { url, title: title || '' }); };
  for (const a of streamedAnnotations) if (a.type === 'url_citation') addUrl(a.url, a.title);
  for (const item of [...output, ...streamedItems]) {
    for (const src of item.action?.sources || []) addUrl(src.url, src.title);
    for (const part of item.content || []) {
      for (const a of part.annotations || []) if (a.type === 'url_citation') addUrl(a.url, a.title);
    }
  }
  // Backup: links OpenAI's web search hands the model carry ?utm_source=openai,
  // so any such link in the answer came from this search.
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    if (/[?&]utm_source=openai\b/.test(m[0])) addUrl(m[0].replace(/[.,;]+$/, ''), '');
  }
  const citations = [...seen.values()];
  if (!text) {
    text = output.flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  }
  return { text, output, usage: completed.usage || null, ms: Math.round(performance.now() - started), webSearches, citations };
}

// When a usage limit resets, if OpenAI says: a Retry-After header, any
// "...reset..." header, or a resets_in/resets_at field in the error body.
function resetSecondsFrom(headers, body) {
  const retry = Number(headers.get('retry-after'));
  if (retry > 0) return retry;
  for (const [name, value] of headers) {
    if (/reset/i.test(name) && Number(value) > 0) return Number(value);
  }
  const e = body?.error || {};
  if (Number(e.resets_in_seconds) > 0) return Number(e.resets_in_seconds);
  if (Number(e.resets_at) > 0) return Math.max(0, Math.round(Number(e.resets_at) - Date.now() / 1000));
  return null;
}

// Print any usage/limit headers OpenAI sends (once per worker start, and on
// every error), so we can see how close the plan is to its limit.
let usageHeadersLogged = false;
function logUsageHeaders(headers, always) {
  if (usageHeadersLogged && !always) return;
  usageHeadersLogged = true;
  const found = [...headers].filter(([name]) => /limit|reset|usage|codex|retry/i.test(name));
  console.info('[FactFlag] ChatGPT usage headers:', found.length ? Object.fromEntries(found) : '(none sent)');
}

// Map OpenAI's plan-usage error codes to clear messages. Limits are fatal:
// FactFlag stops instead of retrying (and OpenAI never bills extra).
function chatgptPlanError(status, code, message) {
  const known = {
    subscription_sharing_usage_limit_exceeded:
      'ChatGPT plan usage limit reached — checking paused. See chatgpt.com/settings/usage.',
    subscription_sharing_user_not_eligible: 'Your ChatGPT plan isn\'t eligible for use in other apps.',
    subscription_sharing_unsupported_capability: `ChatGPT plan doesn't support part of this request: ${message}`,
    subscription_sharing_invalid_user: 'ChatGPT couldn\'t validate your sign-in — sign in again in FactFlag settings.'
  };
  const fatal = ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_user_not_eligible',
    'subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized',
    'chatpass_v2_invalid_authorization_context'].includes(code) || status === 401;
  return new ChatGPTError(known[code] || `ChatGPT error${code ? ` ${code}` : ''}: ${message}`, { status, code, fatal });
}

// ---------- settings-page test ----------
// One realistic verdict request with web search, timed, so we can judge
// whether ChatGPT can replace Groq + Tavily without losing speed or accuracy.
async function chatgptTest() {
  const auth = await loadAuth();
  const model = auth.model || (await chatgptModels())[0]?.slug;
  if (!model) throw new ChatGPTError('No models available for this ChatGPT account.');

  const claim = 'The Great Wall of China is visible from the Moon with the naked eye.';
  const searchTool = { type: 'web_search' };
  const request = {
    model,
    instructions: 'You are a careful fact-checker. Use web search to check the claim, then answer with JSON only.',
    input: [{ role: 'user', content: `CLAIM: ${claim}\nGive a verdict of TRUE, FALSE, MISLEADING or UNVERIFIABLE, a one-sentence explanation, an exact quote from your best source, and its URL.` }],
    textFormat: {
      type: 'json_schema',
      name: 'verdict',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: ['TRUE', 'FALSE', 'MISLEADING', 'UNVERIFIABLE'] },
          explanation: { type: 'string' },
          evidence_quote: { type: 'string' },
          source_url: { type: 'string' }
        },
        required: ['verdict', 'explanation', 'evidence_quote', 'source_url'],
        additionalProperties: false
      }
    }
  };

  let withSearch = true;
  let r;
  try {
    // Force a search, so the model can't answer from memory.
    r = await chatgptRespond({ ...request, tools: [searchTool], toolChoice: 'required' });
  } catch (e) {
    if (e.code !== 'subscription_sharing_unsupported_capability') throw e;
    // Web search not allowed for this plan/model: try once without it.
    withSearch = false;
    r = await chatgptRespond(request);
    r.searchError = e.message;
  }
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch (_) {}
  if (parsed) parsed.explanation = stripMarkdownLinks(parsed.explanation);
  const sourceFound = !!parsed && r.citations.some((c) => sameUrl(c.url, parsed.source_url));
  return {
    sourceFound,
    model,
    claim,
    webSearchAllowed: withSearch,
    webSearchError: r.searchError || '',
    webSearchesMade: r.webSearches,
    seconds: (r.ms / 1000).toFixed(1),
    verdict: parsed,
    rawText: parsed ? '' : r.text.slice(0, 500),
    citations: r.citations.slice(0, 5),
    usage: r.usage
  };
}

// "text ([nasa.gov](https://...))" -> "text"
function stripMarkdownLinks(text) {
  return String(text || '')
    .replace(/\s*\(\[[^\]]*\]\([^)]*\)\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

// Compare URLs ignoring OpenAI's ?utm_source=openai tag, trailing slashes and "www."
function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      x.searchParams.delete('utm_source');
      return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
    } catch (_) {
      return String(u || '').trim();
    }
  };
  return !!a && !!b && norm(a) === norm(b);
}

// One structured (JSON) request on the user's ChatGPT plan, used by every
// FactFlag step when "Check videos using: ChatGPT plan" is selected.
// webSearch: true forces a web search first (the model can't skip it).
// role 'fast' (claim finding) uses the claim-finding model if one is chosen.
async function chatgptJson({ system, user, schemaName, schema, reasoningEffort, webSearch, role }) {
  const auth = await loadAuth();
  const model = (role === 'fast' && auth.fastModel) || auth.model || (await chatgptModels())[0]?.slug;
  if (!model) throw new ChatGPTError('No ChatGPT models available for this account.', { fatal: true });
  const request = {
    model,
    instructions: `${system}\n\nRespond with a JSON object only.`,
    input: [{ role: 'user', content: user }],
    textFormat: { type: 'json_schema', name: schemaName, strict: true, schema },
    promptCacheKey: `factflag-${schemaName}`
  };
  if (webSearch) {
    const P = self.FACTFLAG_PROMPTS || {};
    request.tools = [{ type: 'web_search', search_context_size: P.chatgptSearchContextSize || 'medium' }];
    request.toolChoice = 'required';
    const cap = Number(P.chatgptMaxSearchesPerVerdict);
    if (cap > 0) request.maxToolCalls = cap;
  }
  let r;
  try {
    r = await chatgptRespond({ ...request, reasoningEffort });
  } catch (e) {
    // Some models don't take a reasoning setting — retry once without it.
    if (reasoningEffort && e.code === 'subscription_sharing_unsupported_capability' && /reasoning/i.test(`${e.param} ${e.message}`)) {
      r = await chatgptRespond(request);
    } else {
      throw e;
    }
  }
  let json;
  try {
    json = JSON.parse(r.text);
  } catch (_) {
    throw new ChatGPTError('ChatGPT returned text that is not valid JSON.');
  }
  return { json, usage: r.usage, citations: r.citations, webSearches: r.webSearches, ms: r.ms, model };
}

// Remove OpenAI's ?utm_source=openai tag from a link for display.
function cleanUrl(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('utm_source');
    return u.toString();
  } catch (_) {
    return url;
  }
}
