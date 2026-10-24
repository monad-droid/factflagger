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

function supportsStrictSchema(model) {
  return /gpt-oss/.test(model);
}

// onWait(seconds) is called before each rate-limit wait so the UI can say so.
async function groqChatJson({ apiKey, model, system, user, schemaName, schema, reasoningEffort, onWait }) {
  let useSchema = supportsStrictSchema(model);
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = {
      model,
      messages: [
        { role: 'system', content: system },
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
      const wait = Math.min(Number(res.headers.get('retry-after')) || 10, 120);
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (res.status === 400 && useSchema) {
      // Model may not support strict schemas — fall back to plain JSON mode once.
      useSchema = false;
      continue;
    }
    if (res.status === 401) throw new GroqError('Groq rejected the API key — check Settings.', 401);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error?.message || ''; } catch (_) {}
      throw new GroqError(`Groq HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (_) {
      throw new GroqError('Groq returned text that is not valid JSON.', 0);
    }
    return { json: parsed, usage: data.usage || null };
  }
  throw new GroqError('Groq kept rate-limiting after several retries.', 429);
}
