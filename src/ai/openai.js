/**
 * The common /v1 chat protocol (OpenAI-compatible), as Ollama, llama.cpp,
 * LM Studio, vLLM and hosted services speak it. Shared by Agent Chat and the
 * model router, so there is one reader for replies and one way to explain a
 * server's errors.
 */

export const endpoint = (base, path) => `${String(base).trim().replace(/\/+$/, '')}/${path}`;

export function headers(key = '') {
  const token = String(key).trim();
  return { 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

/**
 * Reads a streamed (server-sent events) or whole chat completion. `feed`
 * takes text as it arrives; `finish` returns { content, toolCalls }.
 */
export function completionReader(onDelta) {
  let buffer = '';
  let content = '';
  let whole = '';
  const calls = [];
  let streamed = false;
  const take = data => {
    if (data === '[DONE]') return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.error) throw new Error(message.error.message ?? String(message.error));
    const delta = message.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === 'string' && delta.content) { content += delta.content; onDelta?.(delta.content); }
    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? calls.length;
      const slot = calls[index] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) slot.id = call.id;
      if (call.function?.name) slot.function.name += call.function.name;
      if (call.function?.arguments) slot.function.arguments += call.function.arguments;
    }
  };
  return {
    feed(text) {
      whole += text;
      buffer += text;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (line.startsWith('data:')) { streamed = true; take(line.slice(5).trim()); }
      }
    },
    finish() {
      if (buffer.startsWith('data:')) { streamed = true; take(buffer.slice(5).trim()); }
      if (!streamed) {
        let message;
        try { message = JSON.parse(whole); } catch { throw new Error(whole.trim() ? `The server answered something that is not a chat reply: ${whole.trim().slice(0, 120)}` : 'The server sent an empty answer.'); }
        if (message.error) throw new Error(message.error.message ?? String(message.error));
        const reply = message.choices?.[0]?.message;
        if (!reply) throw new Error('The server answered without a message.');
        content = typeof reply.content === 'string' ? reply.content : '';
        if (content) onDelta?.(content);
        calls.push(...(reply.tool_calls ?? []));
      }
      return { content, toolCalls: calls.filter(call => call?.function?.name) };
    }
  };
}

/** A sentence for a failed request, with a hint where one helps. */
export function problemText(status, text) {
  let detail = String(text ?? '').trim();
  try { const parsed = JSON.parse(detail); detail = parsed.error?.message ?? parsed.message ?? detail; } catch { /* plain text */ }
  const hint = status === 401 || status === 403 ? ' Check the API key in Setup.' : status === 404 ? ' Check the base URL (it usually ends in /v1) and the model name.' : '';
  const said = String(detail).slice(0, 200);
  return `The server answered ${status}: ${said}${/[.!?]$/.test(said) ? '' : '.'}${hint}`;
}
