import { Hono } from 'hono';
import type { Env } from '../index';

export const summarizeRoutes = new Hono<{ Bindings: Env }>();

const MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>;
}

async function callClaude(
  apiKey: string,
  system: string,
  userMessage: string,
  maxTokens = 4096
): Promise<string> {
  const body: AnthropicRequest = {
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userMessage }],
  };

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data: AnthropicResponse = await res.json();
  const textBlock = data.content.find((b) => b.type === 'text');
  return textBlock?.text ?? '';
}

// ---------------------------------------------------------------------------
// POST /api/summarize
// ---------------------------------------------------------------------------

interface SummarizeBody {
  transcript: string;
  videoTitle: string;
  mode: string;
}

summarizeRoutes.post('/api/summarize', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body: SummarizeBody;
  try {
    body = await c.req.json<SummarizeBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { transcript, videoTitle, mode } = body;
  if (!transcript) {
    return c.json({ error: 'transcript is required' }, 400);
  }

  const system =
    'You are a helpful assistant that processes YouTube video transcripts for import into NotebookLM. ' +
    'Produce clean, well-structured text suitable as a study source.';

  const prompt =
    `Video title: ${videoTitle ?? 'Untitled'}\n` +
    `Processing mode: ${mode ?? 'summarize'}\n\n` +
    `Transcript:\n${transcript}`;

  try {
    const result = await callClaude(apiKey, system, prompt);
    return c.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// POST /api/split-chapters
// ---------------------------------------------------------------------------

interface SplitChaptersBody {
  transcript: string;
}

summarizeRoutes.post('/api/split-chapters', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body: SplitChaptersBody;
  try {
    body = await c.req.json<SplitChaptersBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { transcript } = body;
  if (!transcript) {
    return c.json({ error: 'transcript is required' }, 400);
  }

  const system =
    'You are a helpful assistant that splits YouTube video transcripts into logical chapters. ' +
    'Return a JSON array of objects with "title" and "content" fields.';

  const prompt = `Split this transcript into logical chapters:\n\n${transcript}`;

  try {
    const result = await callClaude(apiKey, system, prompt);
    return c.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 502);
  }
});

// ---------------------------------------------------------------------------
// POST /api/translate
// ---------------------------------------------------------------------------

interface TranslateBody {
  content: string;
  targetLang: string;
}

summarizeRoutes.post('/api/translate', async (c) => {
  const apiKey = c.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return c.json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);
  }

  let body: TranslateBody;
  try {
    body = await c.req.json<TranslateBody>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { content, targetLang } = body;
  if (!content) {
    return c.json({ error: 'content is required' }, 400);
  }
  if (!targetLang) {
    return c.json({ error: 'targetLang is required' }, 400);
  }

  const system =
    `You are a professional translator. Translate the following content to ${targetLang}. ` +
    'Preserve all formatting and structure.';

  try {
    const result = await callClaude(apiKey, system, content);
    return c.json({ result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return c.json({ error: message }, 502);
  }
});
