import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AnthropicProvider,
  createAiProvider,
  estimateCostMicros,
  extractJsonPayload,
  GeminiProvider,
  OllamaProvider,
  OpenAiProvider,
} from '../providers.js';

const TestSchema = z.object({ ok: z.boolean(), count: z.number() });

describe('AI providers', () => {
  it('extracts JSON from markdown code fences and surrounding prose', () => {
    expect(extractJsonPayload('Here you go:\n```json\n{"ok":true,"count":3}\n```')).toEqual({
      ok: true,
      count: 3,
    });
    expect(extractJsonPayload('Result: {"ok": false, "count": 0} done.')).toEqual({
      ok: false,
      count: 0,
    });
  });

  it('calls OpenAI chat completions and vision endpoints cleanly', async () => {
    const urlStr = (input: RequestInfo | URL): string =>
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    const calls: { url: string; body: unknown }[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      calls.push({ url: urlStr(input), body: JSON.parse(init?.body as string) });
      const content =
        calls.length === 1
          ? JSON.stringify({ ok: true, count: 2 })
          : JSON.stringify({ altText: 'Astronaut standing near lander', confidence: 0.92 });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content } }],
            usage: { prompt_tokens: 100, completion_tokens: 20 },
          }),
          { status: 200 },
        ),
      );
    };

    const provider = new OpenAiProvider('sk-test', { model: 'gpt-4o-mini', fetch: mockFetch });
    const res = await provider.completeStructured({
      schemaName: 'Test',
      schema: TestSchema,
      system: 'sys',
      prompt: 'hi',
    });
    expect(res.data).toEqual({ ok: true, count: 2 });
    expect(res.usage.totalTokens).toBe(120);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');

    const imgRes = await provider.describeImage({
      imageBase64: 'AAAA',
      mimeType: 'image/png',
      prompt: 'Describe',
    });
    expect(imgRes.data.altText).toBe('Astronaut standing near lander');
    expect(imgRes.data.confidence).toBe(0.92);
  });

  it('calls Gemini generateContent and normalizes usageMetadata', async () => {
    const mockFetch: typeof fetch = (input) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url).toContain(
        'generativelanguage.googleapis.com',
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"ok":true,"count":5}' }] } }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
          }),
          { status: 200 },
        ),
      );
    };

    const provider = new GeminiProvider('gem-key', { fetch: mockFetch });
    const res = await provider.completeStructured({
      schemaName: 'Test',
      schema: TestSchema,
      system: 'sys',
      prompt: 'hi',
    });
    expect(res.data).toEqual({ ok: true, count: 5 });
    expect(res.usage.inputTokens).toBe(50);
    expect(res.usage.outputTokens).toBe(10);
  });

  it('calls Anthropic messages API with x-api-key header', async () => {
    const mockFetch: typeof fetch = (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('ant-key');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: '{"ok":false,"count":1}' }],
            usage: { input_tokens: 40, output_tokens: 15 },
          }),
          { status: 200 },
        ),
      );
    };

    const provider = new AnthropicProvider('ant-key', { fetch: mockFetch });
    const res = await provider.completeStructured({
      schemaName: 'Test',
      schema: TestSchema,
      system: 'sys',
      prompt: 'hi',
    });
    expect(res.data).toEqual({ ok: false, count: 1 });
    expect(res.usage.totalTokens).toBe(55);
  });

  it('calls local Ollama /api/chat with zero estimated cost', async () => {
    const mockFetch: typeof fetch = (input) => {
      expect(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url).toBe(
        'http://127.0.0.1:11434/api/chat',
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: { content: '{"ok":true,"count":9}' },
            prompt_eval_count: 80,
            eval_count: 12,
          }),
          { status: 200 },
        ),
      );
    };

    const provider = new OllamaProvider({ fetch: mockFetch });
    const res = await provider.completeStructured({
      schemaName: 'Test',
      schema: TestSchema,
      system: 'sys',
      prompt: 'hi',
    });
    expect(res.data).toEqual({ ok: true, count: 9 });
    expect(res.usage.estimatedCostMicros).toBe(0);
    expect(estimateCostMicros('ollama', 'llama3.2', 1000, 500)).toBe(0);
  });

  it('validates provider config in createAiProvider', () => {
    expect(() => createAiProvider({ provider: 'openai' })).toThrow(/API key/i);
    expect(createAiProvider({ provider: 'ollama' }).name).toBe('ollama');
  });
});
