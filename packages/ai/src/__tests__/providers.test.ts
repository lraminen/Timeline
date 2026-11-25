import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AiProviderError,
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

    const calls: { url: string; body: unknown; signal?: AbortSignal | null }[] = [];
    const mockFetch: typeof fetch = (input, init) => {
      calls.push({
        url: urlStr(input),
        body: JSON.parse(init?.body as string),
        signal: init?.signal,
      });
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
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);

    const imgRes = await provider.describeImage({
      imageBase64: 'AAAA',
      mimeType: 'image/png',
      prompt: 'Describe',
    });
    expect(imgRes.data.altText).toBe('Astronaut standing near lander');
    expect(imgRes.data.confidence).toBe(0.92);
  });

  it('calls Gemini generateContent using x-goog-api-key header (never in URL)', async () => {
    const mockFetch: typeof fetch = (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(url).not.toContain('key=');
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-goog-api-key']).toBe('gem-key');
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

  it('calls Anthropic Claude 5.5 without temperature and with output_config.format schema', async () => {
    let sentBody: Record<string, unknown> = {};
    const mockFetch: typeof fetch = (_input, init) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-api-key']).toBe('ant-key');
      sentBody = JSON.parse(init?.body as string) as Record<string, unknown>;
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
    expect(provider.model).toBe('claude-opus-5-5');
    const res = await provider.completeStructured({
      schemaName: 'Test',
      schema: TestSchema,
      system: 'sys',
      prompt: 'hi',
      temperature: 0.4,
    });
    expect(res.data).toEqual({ ok: false, count: 1 });
    expect(res.usage.totalTokens).toBe(55);
    expect('temperature' in sentBody).toBe(false);
    expect(sentBody.output_config).toMatchObject({
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
        },
      },
    });
  });

  it('strips JSON Schema constraints Anthropic structured outputs reject, but still validates them locally', async () => {
    const Constrained = z.object({
      summary: z.string().min(1).max(600),
      confidence: z.number().min(0).max(1),
      ids: z.array(z.string()).min(1),
      pair: z.array(z.number()).min(2).max(2),
      nested: z.object({ label: z.string().min(3) }).optional(),
    });
    let sentSchema: Record<string, unknown> = {};
    let reply = '{"summary":"ok","confidence":0.5,"ids":["a"],"pair":[1,2]}';
    const mockFetch: typeof fetch = (_input, init) => {
      const body = JSON.parse(init?.body as string) as {
        output_config: { format: { schema: Record<string, unknown> } };
      };
      sentSchema = body.output_config.format.schema;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: reply }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200 },
        ),
      );
    };
    const provider = new AnthropicProvider('ant-key', { fetch: mockFetch });
    const request = { schemaName: 'C', schema: Constrained, system: 's', prompt: 'p' };
    await provider.completeStructured(request);

    const wire = JSON.stringify(sentSchema);
    for (const keyword of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems']) {
      expect(wire).not.toContain(`"${keyword}"`);
    }
    const props = sentSchema.properties as Record<string, Record<string, unknown>>;
    expect(props.ids?.minItems).toBe(1); // 0 or 1 is supported and kept
    expect(props.pair?.minItems).toBeUndefined();
    expect(props.summary?.description).toContain('minLength: 1');

    reply = '{"summary":"","confidence":3,"ids":[],"pair":[1]}';
    await expect(provider.completeStructured(request)).rejects.toThrow(
      'AI provider output failed validation',
    );
  });

  it('redacts upstream error bodies from AiProviderError.message while keeping detail for logs', async () => {
    const mockFetch: typeof fetch = () =>
      Promise.resolve(
        new Response('secret account sk-proj-9999 failed quota check', { status: 401 }),
      );
    const provider = new OpenAiProvider('sk-test', { fetch: mockFetch });
    let caught: unknown;
    try {
      await provider.completeStructured({
        schemaName: 'Test',
        schema: TestSchema,
        system: 'sys',
        prompt: 'hi',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiProviderError);
    const apiErr = caught as AiProviderError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.message).toBe('AI provider request failed');
    expect(apiErr.message).not.toContain('sk-proj-9999');
    expect(apiErr.detail).toContain('sk-proj-9999');
  });

  it('calls local Ollama /api/chat with zero estimated cost', async () => {
    const mockFetch: typeof fetch = (input) => {
      expect(
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      ).toBe('http://127.0.0.1:11434/api/chat');
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
