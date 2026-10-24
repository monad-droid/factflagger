// Groq chat API helper (OpenAI-compatible). Used only by the background worker.
// Phase 2 version: one call at a time, with retry on 429 using Groq's retry-after header.
// Full per-model throttling comes in phase 5.

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

class GroqError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function supportsReasoningEffort(model) {
  return /gpt-oss/.test(model);
}

// Models that rejected strict schemas this session, so we don't waste a request
// on them for every chunk.
const strictSchemaRejected = new Set();

function supportsStrictSchema(model) {
  return /gpt-oss/.test(model) && !strictSchemaRejected.has(model);
}

// onWait(seconds) is called before each rate-limit wait so the UI can say so.
// Groq reports remaining allowance on every reply. Per Groq's docs the
// "requests" headers are per DAY and the "tokens" headers are per MINUTE.
function readLimitHeaders(headers) {
  const num = (name) => {
    const v = headers.get(name);
    return v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v);
  };
  return {
    requestsPerDay: num('x-ratelimit-limit-requests'),
    requestsLeftToday: num('x-ratelimit-remaining-requests'),
    requestsResetIn: headers.get('x-ratelimit-reset-requests') || null
  };
}

async function readGroqError(res) {
  try {
    return (await res.json())?.error?.message || '';
  } catch (_) {
    return '';
  }
}

async function groqChatJson({ apiKey, model, system, user, schemaName, schema, reasoningEffort, onWait }) {
  let useSchema = supportsStrictSchema(model);
  let schemaError = '';
  // Groq's plain JSON mode refuses requests whose messages never mention "json",
  // so say it here rather than relying on the editable prompts to include it.
  const systemWithJson = `${system}\n\nRespond with a JSON object only.`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = {
      model,
      messages: [
        { role: 'system', content: systemWithJson },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      response_format: useSchema
        ? { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } }
        : { type: 'json_object' }
    };
    if (supportsReasoningEffort(model) && reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
      body.include_reasoning = false;
    }

    const res = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (res.status === 429) {
      // Groq's 429 message names the limit hit, e.g. "... tokens per day (TPD) ...".
      const message = await readGroqError(res);
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      if (/per day|\((RPD|TPD)\)/i.test(message) || retryAfter > 600) {
        const err = new GroqError(`Groq daily free limit reached for ${model} — resumes tomorrow.`, 429);
        err.fatal = true;
        throw err;
      }
      const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 120);
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 400 && useSchema) {
      // Strict schema rejected — note why, then fall back to plain JSON mode once.
      schemaError = await readGroqError(res);
      console.warn('[FactFlag]', `Groq rejected strict JSON schema for ${model}: ${schemaError || 'no message'}. ` +
        'Retrying in plain JSON mode.');
      useSchema = false;
      strictSchemaRejected.add(model);
      continue;
    }
    if (res.status === 401) throw new GroqError('Groq rejected the API key — check Settings.', 401);
    if (!res.ok) {
      const detail = await readGroqError(res);
      const earlier = schemaError ? ` (strict-schema attempt said: ${schemaError})` : '';
      throw new GroqError(`Groq HTTP ${res.status}${detail ? `: ${detail}` : ''}${earlier}`, res.status);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw new GroqError('Groq returned text that is not valid JSON.', 0);
    }
    return { json: parsed, usage: data.usage || null, limits: readLimitHeaders(res.headers) };
  }
  throw new GroqError('Groq kept rate-limiting after several retries.', 429);
}
