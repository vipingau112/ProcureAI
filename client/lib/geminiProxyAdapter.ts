import { API, tokenStore } from './api';

/**
 * AG Studio LLM adapter for the Insights chat panel. It never calls Gemini from the browser: it posts Studio's
 * request to our own server (/api/studio-ai/turn), which holds the key, and turns the reply into the stream
 * events Studio expects. Studio runs the tools itself; this adapter only relays the model's tool calls.
 * Auth is the same Bearer token the rest of the app uses (the server's CORS setup has no cookies).
 */

type TurnResult = { text: string; toolCalls: { id: string; name: string; args: unknown }[]; model?: string };

export function geminiProxyAdapter(): any {
  return {
    executeTurn(request: any, options?: { signal?: AbortSignal }): any {
      const id = `resp_${Math.random().toString(36).slice(2)}`;
      const createdAt = Date.now();

      const turn: Promise<TurnResult> = (async () => {
        const token = tokenStore.get();
        const res = await fetch(`${API}/api/studio-ai/turn`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(request),
          signal: options?.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error((data as any)?.error || `Insights AI request failed (${res.status})`);
        return data as TurnResult;
      })();
      turn.catch(() => {}); // failures are reported through `complete`, not the stream

      async function* stream(): AsyncGenerator<any> {
        const d = await turn.catch(() => null);
        if (!d) return;
        if (d.text) {
          const messageId = `msg_${id}`;
          yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
          yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: d.text };
          yield { type: 'TEXT_MESSAGE_END', messageId };
        }
        for (const c of d.toolCalls ?? []) {
          yield { type: 'TOOL_CALL_START', toolCallId: c.id, toolCallName: c.name };
          yield { type: 'TOOL_CALL_ARGS', toolCallId: c.id, delta: JSON.stringify(c.args ?? {}) };
          yield { type: 'TOOL_CALL_END', toolCallId: c.id };
        }
      }

      // THE GUESSED PART: output item shapes follow the OpenAI Responses style that the docs' example adapter uses.
      // If the agent replies but never acts, compare with the example's openaiAdapter source and fix the names here.
      const complete = turn.then(
        (d) => {
          const output: any[] = [];
          if (d.text) {
            output.push({ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: d.text }] });
          }
          for (const c of d.toolCalls ?? []) {
            output.push({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}), status: 'completed' });
          }
          return { id, createdAt, status: 'completed', model: d.model, output };
        },
        (err: any) => ({ id, createdAt, status: 'failed', error: { message: err?.message || 'Insights AI failed' }, output: [] }),
      );

      return { stream: stream(), complete };
    },
  };
}