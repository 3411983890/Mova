const MODEL = 'deepseek-v4.1-flash';
const ENDPOINT = 'http://127.0.0.1:8788/v1/chat/completions';

class ModelError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function completionMessages(history) {
  if (!Array.isArray(history) || !history.length || history.length > 500) throw new ModelError('history');
  let size = 0;
  return history.map(message => {
    const { role, text } = message ?? {};
    if (!['user', 'assistant'].includes(role) || typeof text !== 'string' || !text.trim()) {
      throw new ModelError('history');
    }
    size += text.length;
    if (size > 500_000) throw new ModelError('history');
    return { role, content: text };
  });
}

async function* sseData(body) {
  let buffer = '';
  let fields = [];
  let fieldSize = 0;
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) {
        if (fields.length) yield fields.join('\n');
        fields = [];
        fieldSize = 0;
      } else if (line.startsWith('data:')) {
        fieldSize += line.length;
        if (fieldSize > 1_000_000) throw new ModelError('protocol');
        fields.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (buffer.length > 1_000_000) throw new ModelError('protocol');
  }
}

function decodePayload(json) {
  let data;
  try { data = JSON.parse(json); } catch { throw new ModelError('protocol'); }
  if (data?.error) throw new ModelError('upstream');
  return data;
}

async function* streamCompletion(key, history, signal, fetchCompletion = fetch, model = MODEL) {
  const response = await fetchCompletion(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages: completionMessages(history), stream: true }),
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    const { status } = response;
    if (status === 401 || status === 403) throw new ModelError('auth');
    if (status === 404) throw new ModelError('not_found');
    if (status === 429) throw new ModelError('rate_limit');
    throw new ModelError(status >= 500 ? 'upstream' : 'request');
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = decodePayload(await response.text());
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string' && content.trim()) yield content;
    else throw new ModelError('empty');
    return;
  }
  let sawFinish = false;
  for await (const data of sseData(response.body)) {
    signal.throwIfAborted();
    if (data.trim() === '[DONE]') return;
    const choice = decodePayload(data)?.choices?.[0];
    if (choice?.finish_reason) sawFinish = true;
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content) yield content;
  }
  if (!sawFinish) throw new ModelError('interrupted');
}

module.exports = { MODEL, ENDPOINT, ModelError, streamCompletion };
