import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the AI provider so handler tests do not hit the network.
vi.mock('../_ai-provider.js', () => {
  let nextResponse: string = '{}';
  let nextErrors: string[] | null = null;
  let providerCount = 1;
  // Per-provider fan-out responses for callTextAll (consensus). When unset,
  // callTextAll degrades to a single "mock" provider echoing nextResponse so
  // pre-consensus reconcile tests keep working unchanged.
  let allResponses: { provider: string; content: string }[] | null = null;
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
    callTextAll: async () => {
      if (nextErrors) throw new AiProviderError('mock failure', nextErrors);
      return allResponses ?? [{ provider: 'mock', content: nextResponse }];
    },
    extractJSON: (text: string) => {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      return JSON.parse(match ? match[1] : cleaned);
    },
    __setNext: (resp: string) => { nextResponse = resp; nextErrors = null; allResponses = null; },
    __setError: (errs: string[]) => { nextErrors = errs; },
    __setProviderCount: (n: number) => { providerCount = n; },
    __setAllResponses: (rs: { provider: string; content: string }[]) => { allResponses = rs; nextErrors = null; },
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

  it('statement-parse normalizes rows and drops invalid dates/amounts', async () => {
    const mod = await import('../_ai-provider.js') as unknown as { __setNext: (s: string) => void };
    mod.__setNext(JSON.stringify({ rows: [
      { date: '2026-06-14', amount: 1725, type: 'debit', note: 'Room rent', ref: 'UTR123' },
      { date: '2026-06-02', amount: 10000, type: 'income', note: 'From Ravi', ref: '' },
      { date: 'bad-date', amount: 50, type: 'expense', note: 'skip me' },
      { date: '2026-06-05', amount: 0, type: 'expense', note: 'zero skip' },
    ] }));
    const r = await invoke({ mode: 'statement-parse', text: '14 Jun ... 1725 ...' });
    expect(r.statusCode).toBe(200);
    const rows = (r.body as { rows: { date: string; amount: number; type: string }[] }).rows;
    expect(rows).toHaveLength(2);
    // Unknown type collapses to "expense"; explicit "income" is preserved.
    expect(rows[0]).toMatchObject({ date: '2026-06-14', amount: 1725, type: 'expense' });
    expect(rows[1]).toMatchObject({ date: '2026-06-02', amount: 10000, type: 'income' });
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

// ---------------------------------------------------------------------------
// reconcile consensus — majority vote across providers
// ---------------------------------------------------------------------------
describe('reconcile consensus', () => {
  type SetAll = { __setAllResponses: (rs: { provider: string; content: string }[]) => void };
  const verdictJson = (verdict: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ results: [{ index: 0, verdict, matchId: null, categoryId: null, cleanNote: null, confidence: 'high', reason: verdict, ...extra }] });
  const baseBody = {
    mode: 'reconcile',
    rows: [{ date: '2026-06-10', amount: 450, type: 'expense', note: 'UPI-SWIGGY' }],
    candidates: [{ id: 'real1', date: '2026-06-08', amount: 450, type: 'expense', note: 'swiggy' }],
    categories: [{ id: 'food', name: 'Food' }],
  };

  it('majority verdict wins with agreement tag and providers list', async () => {
    const mod = await import('../_ai-provider.js') as unknown as SetAll;
    mod.__setAllResponses([
      { provider: 'groq',   content: verdictJson('missing', { categoryId: 'food' }) },
      { provider: 'nvidia', content: verdictJson('missing') },
      { provider: 'gemini', content: verdictJson('uncertain') },
    ]);
    const r = await invoke(baseBody);
    expect(r.statusCode).toBe(200);
    const body = r.body as { results: Array<Record<string, unknown>>; providers: string[] };
    expect(body.providers).toEqual(['groq', 'nvidia', 'gemini']);
    expect(body.results[0]).toMatchObject({ index: 0, verdict: 'missing', categoryId: 'food', confidence: 'medium', agreement: '2/3' });
  });

  it('unanimous multi-provider verdict gets high confidence', async () => {
    const mod = await import('../_ai-provider.js') as unknown as SetAll;
    mod.__setAllResponses([
      { provider: 'groq',   content: verdictJson('missing') },
      { provider: 'gemini', content: verdictJson('missing') },
    ]);
    const r = await invoke(baseBody);
    expect((r.body as { results: Array<Record<string, unknown>> }).results[0]).toMatchObject({ verdict: 'missing', confidence: 'high', agreement: '2/2' });
  });

  it('a tie demotes to uncertain with low confidence', async () => {
    const mod = await import('../_ai-provider.js') as unknown as SetAll;
    mod.__setAllResponses([
      { provider: 'groq',   content: verdictJson('missing') },
      { provider: 'gemini', content: verdictJson('matched', { matchId: 'real1' }) },
    ]);
    const r = await invoke(baseBody);
    expect((r.body as { results: Array<Record<string, unknown>> }).results[0]).toMatchObject({ verdict: 'uncertain', matchId: null, confidence: 'low' });
  });

  it('matched majority picks the modal matchId', async () => {
    const mod = await import('../_ai-provider.js') as unknown as SetAll;
    mod.__setAllResponses([
      { provider: 'groq',   content: verdictJson('matched', { matchId: 'real1' }) },
      { provider: 'nvidia', content: verdictJson('matched', { matchId: 'real1' }) },
      { provider: 'gemini', content: verdictJson('missing') },
    ]);
    const r = await invoke(baseBody);
    expect((r.body as { results: Array<Record<string, unknown>> }).results[0]).toMatchObject({ verdict: 'matched', matchId: 'real1', agreement: '2/3' });
  });

  it('providers returning junk are dropped, survivors still judge', async () => {
    const mod = await import('../_ai-provider.js') as unknown as SetAll;
    mod.__setAllResponses([
      { provider: 'groq',   content: 'total garbage, not json' },
      { provider: 'gemini', content: verdictJson('missing') },
    ]);
    const r = await invoke(baseBody);
    expect(r.statusCode).toBe(200);
    const body = r.body as { results: Array<Record<string, unknown>>; providers: string[] };
    expect(body.providers).toEqual(['gemini']);
    expect(body.results[0]).toMatchObject({ verdict: 'missing', agreement: '1/1' });
  });

  it('502 when every provider returns junk', async () => {
    const mod = await import('../_ai-provider.js') as unknown as SetAll;
    mod.__setAllResponses([
      { provider: 'groq',   content: 'nope' },
      { provider: 'gemini', content: 'also nope' },
    ]);
    const r = await invoke(baseBody);
    expect(r.statusCode).toBe(502);
  });
});
