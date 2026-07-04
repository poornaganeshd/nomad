import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the AI provider so handler tests do not hit the network.
vi.mock('../_ai-provider.js', () => {
  let nextResponse: string = '{}';
  let nextErrors: string[] | null = null;
  let providerCount = 1;
  class AiProviderError extends Error {
    public readonly providerErrors: string[];
    constructor(message: string, providerErrors: string[]) {
      super(message);
      this.name = 'AiProviderError';
      this.providerErrors = providerErrors;
    }
  }
  return {
    AiProviderError,
    configuredProviderCount: () => providerCount,
    callText: async () => {
      if (nextErrors) throw new AiProviderError('mock failure', nextErrors);
      return nextResponse;
    },
    extractJSON: (text: string) => {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      return JSON.parse(match ? match[1] : cleaned);
    },
    __setNext: (resp: string) => { nextResponse = resp; nextErrors = null; },
    __setError: (errs: string[]) => { nextErrors = errs; },
    __setProviderCount: (n: number) => { providerCount = n; },
  };
});

interface MockRes {
  statusCode: number;
  body: unknown;
  status: (code: number) => MockRes;
  json: (b: unknown) => MockRes;
}
function mockRes(): MockRes {
  const r = { statusCode: 200, body: undefined } as MockRes;
  r.status = (code: number) => { r.statusCode = code; return r; };
  r.json = (b: unknown) => { r.body = b; return r; };
  return r;
}

async function invoke(body: Record<string, unknown>) {
  const handler = (await import('../ai-analyze.js')).default;
  const req = { method: 'POST', body } as Parameters<typeof handler>[0];
  const res = mockRes() as unknown as Parameters<typeof handler>[1];
  await handler(req, res);
  return res as unknown as MockRes;
}

beforeEach(async () => {
  vi.resetModules();
  // Re-import the mock helpers via dynamic import so each test starts clean.
  const mod = await import('../_ai-provider.js') as unknown as {
    __setNext: (resp: string) => void;
    __setError: (errs: string[]) => void;
    __setProviderCount: (n: number) => void;
  };
  mod.__setProviderCount(1);
  mod.__setNext('{}');
});

afterEach(() => vi.restoreAllMocks());

describe('ai-analyze handler', () => {
  it('rejects non-POST', async () => {
    const handler = (await import('../ai-analyze.js')).default;
    const req = { method: 'GET', body: {} } as Parameters<typeof handler>[0];
    const res = mockRes() as unknown as Parameters<typeof handler>[1];
    await handler(req, res);
    const r = res as unknown as MockRes;
    expect(r.statusCode).toBe(405);
  });

  it('rejects unknown mode', async () => {
    const r = await invoke({ mode: 'nope' });
    expect(r.statusCode).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/Unknown mode/);
  });

  it('returns 503 when no providers configured', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setProviderCount: (n: number) => void };
    mod.__setProviderCount(0);
    const r = await invoke({ mode: 'subscriptions', transactions: [] });
    expect(r.statusCode).toBe(503);
  });

  it('voice-parse sanitizes out-of-list walletId and categoryId', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"amount":250,"type":"expense","walletId":"made_up","categoryId":"phantom","note":"tea","confidence":"high"}');
    const r = await invoke({
      mode: 'voice-parse',
      transcript: 'paid 250 for tea',
      wallets:    [{ id: 'bank',   name: 'Bank' }],
      categories: [{ id: 'food',   name: 'Food' }],
    });
    expect(r.statusCode).toBe(200);
    const body = r.body as { amount: number; walletId: string | null; categoryId: string | null; type: string };
    expect(body.amount).toBe(250);
    expect(body.walletId).toBeNull();
    expect(body.categoryId).toBeNull();
    expect(body.type).toBe('expense');
  });

  it('voice-parse keeps walletId and categoryId when they are in the list', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"amount":80,"type":"expense","walletId":"bank","categoryId":"food","note":"chai"}');
    const r = await invoke({
      mode: 'voice-parse',
      transcript: 'chai 80 bank',
      wallets:    [{ id: 'bank', name: 'Bank' }],
      categories: [{ id: 'food', name: 'Food' }],
    });
    expect(r.statusCode).toBe(200);
    const body = r.body as { walletId: string; categoryId: string };
    expect(body.walletId).toBe('bank');
    expect(body.categoryId).toBe('food');
  });

  it('voice-parse defaults invalid type to expense', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"amount":10,"type":"banana","walletId":null,"categoryId":null}');
    const r = await invoke({ mode: 'voice-parse', transcript: 'x', wallets: [], categories: [] });
    expect(r.statusCode).toBe(200);
    expect((r.body as { type: string }).type).toBe('expense');
  });

  it('anomaly clamps invalid severity to none', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"anomaly":true,"severity":"catastrophic","reason":"x"}');
    const r = await invoke({ mode: 'anomaly', txn: { amount: 100 }, history: [] });
    expect(r.statusCode).toBe(200);
    expect((r.body as { severity: string }).severity).toBe('none');
  });

  it('tax fills missing totalDeductible from sum of item amounts', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"items":[{"section":"80C","amount":50000,"note":"PPF"},{"section":"80D","amount":12000,"note":"health"}],"summary":"ok"}');
    const r = await invoke({ mode: 'tax', expenses: [] });
    expect(r.statusCode).toBe(200);
    expect((r.body as { totalDeductible: number }).totalDeductible).toBe(62000);
  });

  it('subscriptions returns shape-validated array', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"subscriptions":[{"merchant":"Netflix","amount":199,"cadence":"monthly","lastDate":"2026-05-01","confidence":"high","note":"x"}]}');
    const r = await invoke({ mode: 'subscriptions', transactions: [] });
    expect(r.statusCode).toBe(200);
    expect((r.body as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
  });

  it('reconcile sanitizes verdicts, ids, and drops out-of-range/duplicate indexes', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext(JSON.stringify({
      results: [
        { index: 0, verdict: 'missing', matchId: null, categoryId: 'food', cleanNote: 'Swiggy', confidence: 'high', reason: 'no match' },
        { index: 1, verdict: 'matched', matchId: 'ghost', categoryId: 'phantom', cleanNote: 'x', confidence: 'weird', reason: 'fuzzy' },
        { index: 1, verdict: 'missing', matchId: null, categoryId: null, cleanNote: null, confidence: 'low', reason: 'dupe' },
        { index: 9, verdict: 'missing', matchId: null, categoryId: null, cleanNote: null, confidence: 'low', reason: 'oob' },
      ],
    }));
    const r = await invoke({
      mode: 'reconcile',
      rows: [
        { date: '2026-06-10', amount: 450, type: 'expense', note: 'UPI-SWIGGY' },
        { date: '2026-06-11', amount: 900, type: 'expense', note: 'POS AMAZON' },
      ],
      candidates: [{ id: 'real1', date: '2026-06-09', amount: 900, type: 'expense', note: 'amazon order' }],
      categories: [{ id: 'food', name: 'Food' }],
    });
    expect(r.statusCode).toBe(200);
    const results = (r.body as { results: Array<{ index: number; verdict: string; matchId: string | null; categoryId: string | null; confidence: string }> }).results;
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ index: 0, verdict: 'missing', categoryId: 'food', confidence: 'high' });
    // "matched" with an id not in the candidate list is unusable → demoted to uncertain.
    expect(results[1]).toMatchObject({ index: 1, verdict: 'uncertain', matchId: null, categoryId: null, confidence: 'low' });
  });

  it('reconcile keeps a valid matchId', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"results":[{"index":0,"verdict":"matched","matchId":"real1","categoryId":null,"cleanNote":null,"confidence":"medium","reason":"same amount 3 days off"}]}');
    const r = await invoke({
      mode: 'reconcile',
      rows: [{ date: '2026-06-10', amount: 900, type: 'expense', note: 'POS AMAZON' }],
      candidates: [{ id: 'real1', date: '2026-06-07', amount: 900, type: 'expense', note: 'amazon' }],
      categories: [],
    });
    expect(r.statusCode).toBe(200);
    const results = (r.body as { results: Array<{ verdict: string; matchId: string }> }).results;
    expect(results[0].verdict).toBe('matched');
    expect(results[0].matchId).toBe('real1');
  });

  it('502 when AI returns non-JSON', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('not json at all');
    const r = await invoke({ mode: 'subscriptions', transactions: [] });
    expect(r.statusCode).toBe(502);
  });

  it('502 when validate fails', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext('{"unexpected":"shape"}');
    const r = await invoke({ mode: 'subscriptions', transactions: [] });
    expect(r.statusCode).toBe(502);
  });

  it('502 when all providers fail', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setError: (errs: string[]) => void };
    mod.__setError(['gemini boom', 'groq boom']);
    const r = await invoke({ mode: 'subscriptions', transactions: [] });
    expect(r.statusCode).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/All AI providers failed/);
  });
});
