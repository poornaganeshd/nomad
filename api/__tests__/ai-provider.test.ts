import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// getProviders() reads process.env at call time, so env vars can be set per test.

const clearKeys = () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.NVIDIA_API_KEY;
};

// ---------------------------------------------------------------------------
// extractJSON
// ---------------------------------------------------------------------------
describe('extractJSON', () => {
  it('parses a plain JSON object', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    expect(extractJSON<{ name: string }>('{"name":"test"}')).toEqual({ name: 'test' });
  });

  it('parses a plain JSON array', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    expect(extractJSON<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    const result = extractJSON<{ val: number }>('```json\n{"val":42}\n```');
    expect(result).toEqual({ val: 42 });
  });

  it('strips plain ``` fences without json tag', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    const result = extractJSON<{ x: number }>('```\n{"x":1}\n```');
    expect(result).toEqual({ x: 1 });
  });

  it('extracts JSON object from mid-text preamble', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    const result = extractJSON<{ score: number }>('Sure! Here is the result: {"score":5}');
    expect(result).toEqual({ score: 5 });
  });

  it('extracts JSON array from mid-text preamble', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    const result = extractJSON<string[]>('Here you go: ["a","b"]');
    expect(result).toEqual(['a', 'b']);
  });

  it('throws on text with no valid JSON', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    expect(() => extractJSON('no json here at all')).toThrow();
  });

  it('handles nested objects', async () => {
    const { extractJSON } = await import('../_ai-provider.js');
    const result = extractJSON<{ a: { b: number } }>('{"a":{"b":99}}');
    expect(result.a.b).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// configuredProviderCount
// ---------------------------------------------------------------------------
describe('configuredProviderCount', () => {
  beforeEach(clearKeys);
  afterEach(clearKeys);

  it('returns 0 when no keys are set', async () => {
    const { configuredProviderCount } = await import('../_ai-provider.js');
    expect(configuredProviderCount()).toBe(0);
  });

  it('returns 1 when only GEMINI_API_KEY is set', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    const { configuredProviderCount } = await import('../_ai-provider.js');
    expect(configuredProviderCount()).toBe(1);
  });

  it('returns 2 when GEMINI and GROQ keys are set', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.GROQ_API_KEY   = 'q-test';
    const { configuredProviderCount } = await import('../_ai-provider.js');
    expect(configuredProviderCount()).toBe(2);
  });

  it('returns 3 when all three keys are set', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.GROQ_API_KEY   = 'q-test';
    process.env.NVIDIA_API_KEY = 'n-test';
    const { configuredProviderCount } = await import('../_ai-provider.js');
    expect(configuredProviderCount()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// callText — provider waterfall
// ---------------------------------------------------------------------------
describe('callText', () => {
  const origFetch = globalThis.fetch;

  beforeEach(clearKeys);
  afterEach(() => {
    clearKeys();
    globalThis.fetch = origFetch;
  });

  it('throws AiProviderError when no providers configured', async () => {
    const { callText, AiProviderError } = await import('../_ai-provider.js');
    await expect(callText('hello')).rejects.toBeInstanceOf(AiProviderError);
  });

  it('throws with "No AI API keys configured." message', async () => {
    const { callText } = await import('../_ai-provider.js');
    await expect(callText('hello')).rejects.toThrow('No AI API keys configured.');
  });

  it('returns content string on successful provider response', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
    } as unknown as Response);

    const { callText } = await import('../_ai-provider.js');
    const result = await callText('test prompt');
    expect(result).toBe('{"ok":true}');
  });

  it('falls through to second provider when first returns non-2xx', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.GROQ_API_KEY   = 'q-test';

    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return { ok: false, text: async () => 'Quota exceeded' } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'groq-response' } }] }),
      } as unknown as Response;
    });

    const { callText } = await import('../_ai-provider.js');
    const result = await callText('test');
    expect(result).toBe('groq-response');
    expect(callCount).toBe(2);
  });

  it('throws AiProviderError when all providers fail', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => 'Error',
    } as unknown as Response);

    const { callText, AiProviderError } = await import('../_ai-provider.js');
    await expect(callText('test')).rejects.toBeInstanceOf(AiProviderError);
  });

  it('collects per-provider errors in AiProviderError.providerErrors', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    process.env.GROQ_API_KEY   = 'q-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => 'Server error',
    } as unknown as Response);

    const { callText, AiProviderError } = await import('../_ai-provider.js');
    let err: InstanceType<typeof AiProviderError> | null = null;
    try {
      await callText('test');
    } catch (e) {
      err = e as InstanceType<typeof AiProviderError>;
    }
    expect(err).not.toBeNull();
    expect(err!.providerErrors).toHaveLength(2);
    err!.providerErrors.forEach(msg => expect(typeof msg).toBe('string'));
  });
});

// ---------------------------------------------------------------------------
// callTextAll — parallel fan-out for consensus
// ---------------------------------------------------------------------------
describe('callTextAll', () => {
  const origFetch = globalThis.fetch;

  beforeEach(clearKeys);
  afterEach(() => {
    clearKeys();
    globalThis.fetch = origFetch;
  });

  it('throws AiProviderError when no providers configured', async () => {
    const { callTextAll, AiProviderError } = await import('../_ai-provider.js');
    await expect(callTextAll('hello')).rejects.toBeInstanceOf(AiProviderError);
  });

  it('returns one answer per configured provider', async () => {
    process.env.GROQ_API_KEY   = 'q-test';
    process.env.GEMINI_API_KEY = 'g-test';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: String(url).includes('groq') ? 'groq-says' : 'gemini-says' } }] }),
    } as unknown as Response));

    const { callTextAll } = await import('../_ai-provider.js');
    const answers = await callTextAll('test');
    expect(answers).toHaveLength(2);
    const byName = Object.fromEntries(answers.map(a => [a.provider, a.content]));
    expect(byName.groq).toBe('groq-says');
    expect(byName.gemini).toBe('gemini-says');
  });

  it('drops failing providers but returns the survivors', async () => {
    process.env.GROQ_API_KEY   = 'q-test';
    process.env.GEMINI_API_KEY = 'g-test';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes('groq')) return { ok: false, text: async () => 'quota' } as unknown as Response;
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'gemini-only' } }] }) } as unknown as Response;
    });

    const { callTextAll } = await import('../_ai-provider.js');
    const answers = await callTextAll('test');
    expect(answers).toHaveLength(1);
    expect(answers[0]).toEqual({ provider: 'gemini', content: 'gemini-only' });
  });

  it('throws AiProviderError when every provider fails', async () => {
    process.env.GROQ_API_KEY   = 'q-test';
    process.env.GEMINI_API_KEY = 'g-test';
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, text: async () => 'boom' } as unknown as Response);

    const { callTextAll, AiProviderError } = await import('../_ai-provider.js');
    let err: InstanceType<typeof AiProviderError> | null = null;
    try { await callTextAll('test'); } catch (e) { err = e as InstanceType<typeof AiProviderError>; }
    expect(err).not.toBeNull();
    expect(err!.providerErrors).toHaveLength(2);
  });

  it('throws when provider returns empty content', async () => {
    process.env.GEMINI_API_KEY = 'g-test';
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
    } as unknown as Response);

    const { callText, AiProviderError } = await import('../_ai-provider.js');
    await expect(callText('test')).rejects.toBeInstanceOf(AiProviderError);
  });
});

// ---------------------------------------------------------------------------
// AiProviderError shape
// ---------------------------------------------------------------------------
describe('AiProviderError', () => {
  it('has name "AiProviderError"', async () => {
    const { AiProviderError } = await import('../_ai-provider.js');
    const err = new AiProviderError('test msg', ['e1', 'e2']);
    expect(err.name).toBe('AiProviderError');
  });

  it('exposes providerErrors array', async () => {
    const { AiProviderError } = await import('../_ai-provider.js');
    const err = new AiProviderError('fail', ['err-a', 'err-b']);
    expect(err.providerErrors).toEqual(['err-a', 'err-b']);
  });

  it('is an instance of Error', async () => {
    const { AiProviderError } = await import('../_ai-provider.js');
    const err = new AiProviderError('fail', []);
    expect(err).toBeInstanceOf(Error);
  });
});
