import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Ask NOMAD answered a plain "Hello" with "All AI providers failed. Try again
// later." Two separate faults, both covered here:
//
//   1. Every message shipped the whole 500-row ledger — including questions
//      that need no lookup at all. That prompt is ~6k tokens, roughly a free
//      provider tier's ENTIRE per-minute allowance, so the chat rate-limited
//      itself and every provider refused at once.
//   2. Whatever the cause, the bubble said the same thing. A rejected API key,
//      an exhausted quota and a retired model are three different problems
//      with three different fixes, and none of them is "try again later".

const clearKeys = () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.NVIDIA_API_KEY;
};

const mkRes = () => {
  const res: any = { statusCode: 0, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  return res;
};

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ d: '2026-09-01', a: 100 + i, c: 'Food', w: 'Bank', n: `item ${i}` }));

describe('summarizeProviderErrors', () => {
  it('names the cause instead of "try again later"', async () => {
    const { summarizeProviderErrors } = await import('../_ai-provider.js');
    expect(summarizeProviderErrors(['groq HTTP 429: {"error":{"message":"Rate limit reached"}}']))
      .toBe('groq: rate limit or quota reached');
    expect(summarizeProviderErrors(['groq HTTP 401: invalid api key']))
      .toBe('groq: API key rejected');
    expect(summarizeProviderErrors(['nvidia HTTP 400: model has been decommissioned']))
      .toBe('nvidia: model unavailable');
    expect(summarizeProviderErrors(['gemini HTTP 503: service unavailable']))
      .toBe('gemini: provider error (HTTP 503)');
    expect(summarizeProviderErrors(['groq: empty response'])).toBe('groq: returned nothing');
  });

  it('collapses the same cause across providers and caps the list', async () => {
    const { summarizeProviderErrors } = await import('../_ai-provider.js');
    const out = summarizeProviderErrors(['groq HTTP 429: x', 'groq HTTP 429: y', 'nvidia HTTP 429: z']);
    expect(out).toBe('groq: rate limit or quota reached; nvidia: rate limit or quota reached');
  });

  it('is empty when there is nothing to explain', async () => {
    const { summarizeProviderErrors } = await import('../_ai-provider.js');
    expect(summarizeProviderErrors([])).toBe('');
  });
});

describe('POST /api/ai-chat', () => {
  beforeEach(() => { clearKeys(); vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); clearKeys(); });

  it('503s with no providers configured', async () => {
    const handler = (await import('../ai-chat.js')).default;
    const res = mkRes();
    await handler({ method: 'POST', body: { question: 'how much did I spend' } } as any, res);
    expect(res.statusCode).toBe(503);
  });

  it('reports WHY every provider refused', async () => {
    process.env.GROQ_API_KEY = 'k';
    global.fetch = vi.fn(async () => new Response('{"error":"rate limit"}', { status: 429 })) as any;
    const handler = (await import('../ai-chat.js')).default;
    const res = mkRes();
    await handler({ method: 'POST', body: { question: 'how much did I spend', context: {} } } as any, res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error).toContain('rate limit or quota reached');
    expect(res.body.error).not.toBe('All AI providers failed. Try again later.');
  });

  it('retries once with a trimmed ledger and flags the answer as partial', async () => {
    process.env.GROQ_API_KEY = 'k';
    const seen: number[] = [];
    global.fetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const prompt = body.messages[1].content as string;
      seen.push((prompt.match(/^2026-09-01\|/gm) || []).length);
      // Refuse the big prompt, accept the small one — exactly a per-minute
      // token allowance being the binding constraint.
      if (seen[seen.length - 1] > 200) return new Response('{"error":"too many tokens"}', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'You spent ₹500.' } }] }), { status: 200 });
    }) as any;
    const handler = (await import('../ai-chat.js')).default;
    const res = mkRes();
    await handler({ method: 'POST', body: { question: 'how much did I spend', context: { expenses: rows(500) } } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.trimmed).toBe(true);
    expect(seen[0]).toBe(500);
    expect(seen[1]).toBe(120);
  });

  it('does not retry the grounded path — it has nothing left to shed', async () => {
    process.env.GROQ_API_KEY = 'k';
    const calls = vi.fn(async () => new Response('{"error":"nope"}', { status: 429 }));
    global.fetch = calls as any;
    const handler = (await import('../ai-chat.js')).default;
    const res = mkRes();
    await handler({ method: 'POST', body: { question: 'how much on eggs', context: { queryFacts: 'TOTAL: ₹420', expenses: rows(500) } } } as any, res);
    expect(res.statusCode).toBe(502);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('a summaries-only question sends no rows at all', async () => {
    process.env.GROQ_API_KEY = 'k';
    let prompt = '';
    global.fetch = vi.fn(async (_url: any, init: any) => {
      prompt = JSON.parse(init.body).messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'Hi!' } }] }), { status: 200 });
    }) as any;
    const handler = (await import('../ai-chat.js')).default;
    const res = mkRes();
    // This is the shape the client now posts for a greeting (chat-query said
    // needsData: false), and it must stay small.
    await handler({ method: 'POST', body: { question: 'Hello there', context: { today: '2026-09-15', monthExpense: 5149, walletBalances: [{ name: 'Bank', balance: 558 }] } } } as any, res);
    expect(res.statusCode).toBe(200);
    expect(prompt).not.toContain('EXPENSE ROWS');
    expect(prompt.length).toBeLessThan(1000);
  });

  it('still rejects an empty question', async () => {
    process.env.GROQ_API_KEY = 'k';
    const handler = (await import('../ai-chat.js')).default;
    const res = mkRes();
    await handler({ method: 'POST', body: { question: 'a' } } as any, res);
    expect(res.statusCode).toBe(400);
  });
});
