import { GoogleGenAI } from '@google/genai';
import { Router } from 'express';
import { config } from './config';

/**
 * POST /api/studio-ai/turn: one LLM turn for AG Studio's Agent Framework (the Insights chat panel), backed by Gemini.
 * The key stays on the server. The browser adapter posts Studio's request and gets back { text, toolCalls, model }.
 * Studio runs the tools itself in the browser; this route only relays the model's answer and tool calls.
 */
export const studioAiRouter = Router();

const DEBUG = process.env.STUDIO_AI_DEBUG === 'true';
const PER_USER_PER_DAY = Number(process.env.STUDIO_AI_TURNS_PER_USER_PER_DAY) || 80;
const ALL_USERS_PER_DAY = Number(process.env.STUDIO_AI_TURNS_PER_DAY) || 300;

const today = () => new Date().toISOString().slice(0, 10);
let total = { day: '', n: 0 };
const perUser = new Map<string, { day: string; n: number }>();

/** Separate from the procurement agent's AI-run cap, so the chat panel can never use up the main demo's quota. */
function allowTurn(userId: string): boolean {
  const day = today();
  if (total.day !== day) total = { day, n: 0 };
  const u = perUser.get(userId);
  const mine = !u || u.day !== day ? { day, n: 0 } : u;
  if (total.n >= ALL_USERS_PER_DAY || mine.n >= PER_USER_PER_DAY) return false;
  total.n++;
  mine.n++;
  perUser.set(userId, mine);
  return true;
}

// Newer Gemini models want each function call's thought signature sent back on the next turn.
// Studio's conversation items do not carry it, so keep it here, keyed by the call id we hand out.
const signatures = new Map<string, string>();

const textOf = (content: any): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('')
      : '';

/**
 * Studio conversation items (OpenAI-Responses-like) -> Gemini contents.
 * THE GUESSED PART: the field names below come from the docs' wording, not from a spec I could read.
 * If the agent answers but never acts, run with STUDIO_AI_DEBUG=true and look at what arrives.
 */
function toGemini(input: any[] | undefined) {
  const names: Record<string, string> = {}; // call_id -> tool name
  const contents: { role: string; parts: any[] }[] = [];
  const system: string[] = [];
  const push = (role: string, part: any) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };

  for (const it of input ?? []) {
    const type = it?.type || (it?.role ? 'message' : '');
    if (type === 'message') {
      const text = textOf(it.content);
      if (!text) continue;
      if (it.role === 'system' || it.role === 'developer') system.push(text);
      else push(it.role === 'assistant' || it.role === 'model' ? 'model' : 'user', { text });
    } else if (type === 'function_call') {
      const id = it.call_id || it.id;
      names[id] = it.name;
      let args = it.arguments;
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args || '{}');
        } catch {
          args = {};
        }
      }
      const part: any = { functionCall: { name: it.name, args: args ?? {} } };
      const sig = signatures.get(id);
      if (sig) part.thoughtSignature = sig;
      push('model', part);
    } else if (type === 'function_call_output') {
      let out: any = it.output;
      if (typeof out === 'string') {
        try {
          out = JSON.parse(out);
        } catch {
          /* keep the string */
        }
      }
      if (out === null || typeof out !== 'object' || Array.isArray(out)) out = { result: out };
      push('user', { functionResponse: { name: names[it.call_id] || it.name || 'tool', response: out } });
    } else if (DEBUG) {
      console.log('[studio-ai] skipped item', JSON.stringify(it).slice(0, 200));
    }
  }
  return { contents, system };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function generate(ai: GoogleGenAI, args: any): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await Promise.race([
        ai.models.generateContent(args),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini took longer than 45s (timeout)')), 45000)),
      ]);
    } catch (e: any) {
      const retryable = /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded/i.test(String(e?.message ?? e));
      if (!retryable || attempt >= 2) throw e;
      await sleep(3000 * 2 ** attempt); // 3s, 6s
    }
  }
}

/** A short, safe message for the browser (never the full provider error). */
function brief(e: any): string {
  const m = String(e?.message ?? e);
  if (/429|RESOURCE_EXHAUSTED|quota|rate/i.test(m)) return 'The AI is rate-limited right now. Please try again in a minute.';
  if (/503|UNAVAILABLE|overloaded|high demand/i.test(m)) return 'The AI service is busy. Please try again.';
  if (/401|403|API key|permission/i.test(m)) return 'AI key problem on the server.';
  if (/400|INVALID_ARGUMENT/i.test(m)) return `The AI rejected the request: ${m.replace(/\s+/g, ' ').slice(0, 200)}`;
  if (/timeout/i.test(m)) return 'The AI took too long to answer. Please try again.';
  return 'The AI request failed.';
}

// Mounted behind requireAuth in index.ts, so req.user is set.
studioAiRouter.post('/turn', async (req: any, res) => {
  try {
    if (!config.geminiKey) return res.status(503).json({ error: 'The Insights AI needs GEMINI_API_KEY on the server.' });
    if (!allowTurn(req.user?.id ?? req.ip)) return res.status(429).json({ error: 'The Insights AI has reached its limit for today.' });

    const { input, instructions, tools, toolChoice, responseFormat } = req.body ?? {};
    if (DEBUG) {
      console.log(
        '[studio-ai] request',
        JSON.stringify({ items: (input ?? []).length, tools: (tools ?? []).map((t: any) => t.name), toolChoice, lastItems: (input ?? []).slice(-2) }).slice(0, 2500),
      );
    }

    const { contents, system } = toGemini(input);
    const systemText = [instructions, ...system].filter(Boolean).join('\n\n');

    const functionDeclarations = (tools ?? [])
      .filter((t: any) => t.kind !== 'provided')
      .map((t: any) => {
        const hasProps = Object.keys(t.parameters?.properties ?? {}).length > 0;
        // Same field the existing procurement agent already uses for its tool schemas.
        // Trimmed to type/properties/required, exactly like the working procurement agent does for its own tools.
        return hasProps
          ? { name: t.name, description: t.description ?? '', parametersJsonSchema: { type: 'object', properties: t.parameters.properties, required: t.parameters.required ?? [] } }
          : { name: t.name, description: t.description ?? '' };
      });

    const cfg: any = { temperature: 0.2 };
    if (systemText) cfg.systemInstruction = systemText;
    if (functionDeclarations.length) {
      cfg.tools = [{ functionDeclarations }];
      const forced = typeof toolChoice === 'object' && toolChoice?.name ? String(toolChoice.name) : '';
      const mode = toolChoice === 'none' ? 'NONE' : toolChoice === 'required' || forced ? 'ANY' : 'AUTO';
      cfg.toolConfig = { functionCallingConfig: { mode, ...(forced ? { allowedFunctionNames: [forced] } : {}) } };
    }
    if (/json/i.test(String(responseFormat?.type ?? ''))) cfg.responseMimeType = 'application/json';

    const ai = new GoogleGenAI({ apiKey: config.geminiKey });
    // Diagnostics: STUDIO_AI_PROBE = plain | notools | nosystem trims the request; STUDIO_AI_MODEL swaps the model. Unset = normal.
    const probe = String(process.env.STUDIO_AI_PROBE ?? '');
    const model = process.env.STUDIO_AI_MODEL || config.geminiModel;
    if (probe === 'notools' || probe === 'plain') { delete cfg.tools; delete cfg.toolConfig; }
    if (probe === 'nosystem' || probe === 'plain') delete cfg.systemInstruction;
    if (DEBUG) console.log('[studio-ai] calling gemini', JSON.stringify({ probe, model, contentsChars: JSON.stringify(contents).length, systemChars: systemText.length, toolsChars: JSON.stringify(functionDeclarations).length, tools: functionDeclarations.length }));
    const t0 = Date.now();
    let r: any;
    try {
      // Low thinking keeps the chat fast. If this model does not accept the setting, retry without it.
      r = await generate(ai, { model, contents, config: { ...cfg, thinkingConfig: { thinkingLevel: 'LOW' } } });
    } catch (e: any) {
      if (!/thinking/i.test(String(e?.message ?? e))) throw e;
      if (DEBUG) console.log('[studio-ai] thinkingLevel not accepted, retrying without it');
      r = await generate(ai, { model, contents, config: cfg });
    }
    if (DEBUG) console.log('[studio-ai] gemini', JSON.stringify({ ms: Date.now() - t0, usage: r.usageMetadata, promptChars: JSON.stringify(contents).length + systemText.length }));

    const cand = r.candidates?.[0];
    let text = '';
    const toolCalls: { id: string; name: string; args: unknown }[] = [];
    for (const p of cand?.content?.parts ?? []) {
      if (p.functionCall) {
        const id = `call_${Math.random().toString(36).slice(2, 10)}`;
        if (p.thoughtSignature) {
          signatures.set(id, p.thoughtSignature);
          if (signatures.size > 2000) signatures.delete(signatures.keys().next().value as string);
        }
        toolCalls.push({ id, name: p.functionCall.name, args: p.functionCall.args ?? {} });
      } else if (p.text && !p.thought) {
        text += p.text;
      }
    }
    if (DEBUG) console.log('[studio-ai] reply', JSON.stringify({ finish: cand?.finishReason, text: text.slice(0, 300), toolCalls }).slice(0, 2000));
    if (!text && !toolCalls.length) {
      const why = cand?.finishReason ?? r.promptFeedback?.blockReason ?? 'empty reply';
      return res.status(502).json({ error: `The AI returned nothing (${why}).` });
    }
    res.json({ text, toolCalls, model: r.modelVersion ?? config.geminiModel });
  } catch (e: any) {
    console.error('[studio-ai] failed:', e?.message ?? e);
    res.status(502).json({ error: brief(e) });
  }
});