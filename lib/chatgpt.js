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
      model: auth.model || ''
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
    model: auth.model || ''
  };
}

async function chatgptSetModel(model) {
  const auth = await loadAuth();
  await saveAuth({ ...auth, model });
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
  await saveAuth({ hostId: auth.hostId, clientId: auth.clientId, subject: auth.subject, email: auth.email, model: auth.model });
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
async function chatgptRespond({ model, instructions, input, tools, textFormat, reasoningEffort, signal }) {
  const body = { model, instructions, input, store: false, stream: true };
  if (tools?.length) body.tools = tools;
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
    throw chatgptPlanError(res.status, code, `${message}${param ? ` (param: ${param})` : ''}`);
  }

  // Parse the server-sent event stream.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let completed = null;
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

  const output = completed.output || [];
  const webSearches = output.filter((o) => o.type === 'web_search_call').length;
  const citations = [];
  for (const item of output) {
    for (const part of item.content || []) {
      for (const a of part.annotations || []) {
        if (a.type === 'url_citation' && a.url) citations.push({ url: a.url, title: a.title || '' });
      }
    }
  }
  if (!text) {
    text = output.flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
  }
  return { text, output, usage: completed.usage || null, ms: Math.round(performance.now() - started), webSearches, citations };
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
    r = await chatgptRespond({ ...request, tools: [{ type: 'web_search' }] });
  } catch (e) {
    if (e.code !== 'subscription_sharing_unsupported_capability') throw e;
    // Web search not allowed for this plan/model: try once without it.
    withSearch = false;
    r = await chatgptRespond(request);
    r.searchError = e.message;
  }
  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch (_) {}
  return {
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
