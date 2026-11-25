import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiImageRequest,
  AiProvider,
  AiProviderConfig,
  AiProviderName,
  AiUsage,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

const DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-opus-5-5',
  ollama: 'llama3.2',
  mock: 'mock-model',
};

/** Rough per-1M-token USD prices [inputUsd, outputUsd] for budget tracking (2026 rates). */
const MODEL_PRICING: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-5-mini': [0.25, 2.0],
  'gpt-4o': [2.5, 10.0],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-pro': [1.25, 10.0],
  'claude-opus-5-5': [4.0, 20.0],
  'claude-sonnet-5-5': [2.0, 10.0],
  'claude-haiku-5-5': [0.1, 0.5],
};

export function estimateCostMicros(
  provider: AiProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  if (provider === 'ollama' || provider === 'mock') return 0;
  const [inUsd, outUsd] = MODEL_PRICING[model] ?? [1.0, 3.0];
  // 1M tokens at $X = X * 1_000_000 micros, so per-token is X micros.
  return Math.round(inputTokens * inUsd + outputTokens * outUsd);
}

export function emptyUsage(): AiUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostMicros: 0 };
}

export function mergeUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    estimatedCostMicros: a.estimatedCostMicros + b.estimatedCostMicros,
  };
}

export class AiProviderError extends Error {
  constructor(
    readonly provider: AiProviderName,
    readonly status: number | undefined,
    message: string,
    /** Internal diagnostic details for server logs only — never return directly to clients. */
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** Extracts the first balanced JSON object or array from an LLM text response. */
export function extractJsonPayload(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const startObj = candidate.indexOf('{');
    const startArr = candidate.indexOf('[');
    const start =
      startObj === -1 ? startArr : startArr === -1 ? startObj : Math.min(startObj, startArr);
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('Model response did not contain valid JSON');
  }
}

function validateOutput<T>(
  request: AiCompletionRequest<T>,
  rawText: string,
  provider: AiProviderName,
): T {
  let parsedJson: unknown;
  try {
    parsedJson = extractJsonPayload(rawText);
  } catch (err) {
    throw new AiProviderError(
      provider,
      undefined,
      'AI provider returned invalid JSON',
      `Failed to parse JSON from ${provider}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const checked = request.schema.safeParse(parsedJson);
  if (!checked.success) {
    const msg = checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AiProviderError(
      provider,
      undefined,
      'AI provider output failed validation',
      `Model output failed schema validation: ${msg}`,
    );
  }
  return checked.data;
}

function buildUsage(
  provider: AiProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
): AiUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostMicros: estimateCostMicros(provider, model, inputTokens, outputTokens),
  };
}

async function postJson(
  fetchFn: typeof fetch,
  provider: AiProviderName,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AiProviderError(
      provider,
      isTimeout ? 504 : undefined,
      isTimeout ? 'AI provider request timed out' : 'AI provider request failed',
      `${provider} network failure: ${detail}`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new AiProviderError(
      provider,
      res.status,
      'AI provider request failed',
      `${provider} API error (${String(res.status)}): ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * JSON Schema keywords that Anthropic structured outputs do not accept. Sending them
 * returns a 400, so they are removed from the wire schema and restated in the
 * description as a hint. The zod schema still enforces them when the response is validated.
 */
const ANTHROPIC_UNSUPPORTED_KEYWORDS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'minProperties',
  'maxProperties',
] as const;

function stripUnsupportedConstraints(node: Record<string, unknown>): Record<string, unknown> {
  const unsupported = new Set<string>(ANTHROPIC_UNSUPPORTED_KEYWORDS);
  const hints: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    // Only minItems of 0 or 1 is supported.
    const dropped =
      key === '$schema' ||
      unsupported.has(key) ||
      (key === 'minItems' && typeof value === 'number' && value > 1);
    if (!dropped) {
      kept[key] = value;
    } else if (key !== '$schema') {
      hints.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  if (hints.length > 0) {
    const note = `{${hints.join(', ')}}`;
    kept.description =
      typeof kept.description === 'string' && kept.description
        ? `${kept.description} ${note}`
        : note;
  }
  return kept;
}

function ensureAdditionalPropertiesFalse(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => ensureAdditionalPropertiesFalse(item));
  }
  if (!node || typeof node !== 'object') return node;

  const obj = stripUnsupportedConstraints(node as Record<string, unknown>);
  if (obj.type === 'object' && obj.additionalProperties === undefined) {
    obj.additionalProperties = false;
  }
  if (obj.properties && typeof obj.properties === 'object') {
    const props = obj.properties as Record<string, unknown>;
    const nextProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      nextProps[k] = ensureAdditionalPropertiesFalse(v);
    }
    obj.properties = nextProps;
  }
  if (obj.items !== undefined) {
    obj.items = ensureAdditionalPropertiesFalse(obj.items);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(obj[key])) {
      obj[key] = (obj[key] as unknown[]).map((v) => ensureAdditionalPropertiesFalse(v));
    }
  }
  return obj;
}

function toAnthropicJsonSchema(
  schema: z.ZodType<unknown, z.ZodTypeDef, unknown>,
): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, { target: 'jsonSchema7', $refStrategy: 'none' });
  return ensureAdditionalPropertiesFalse(raw) as Record<string, unknown>;
}

const AltTextOutputSchema = z.object({
  altText: z.string(),
  confidence: z.number(),
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  readonly supportsVision = true;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options?: { model?: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.model = options?.model || DEFAULT_MODELS.openai;
    this.baseUrl = (options?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchFn = options?.fetch ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const data = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 2048,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${request.system}\nReturn strictly valid JSON matching the requested structure.`,
          },
          { role: 'user', content: request.prompt },
        ],
      },
      this.timeoutMs,
    );

    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    const content = choices?.[0]?.message?.content ?? '';
    const usageRaw = data.usage as
      { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const usage = buildUsage(
      this.name,
      this.model,
      usageRaw?.prompt_tokens ?? 0,
      usageRaw?.completion_tokens ?? 0,
    );

    return {
      data: validateOutput(request, content, this.name),
      usage,
      provider: this.name,
      model: this.model,
    };
  }

  async describeImage(
    request: AiImageRequest,
  ): Promise<AiCompletionResult<{ altText: string; confidence: number }>> {
    const imageUrl = request.imageBase64
      ? `data:${request.mimeType};base64,${request.imageBase64}`
      : request.imageUrl;
    if (!imageUrl) throw new AiProviderError(this.name, undefined, 'No image provided');

    const data = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/chat/completions`,
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        temperature: 0.2,
        max_tokens: request.maxTokens ?? 300,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'Return JSON {"altText": string, "confidence": number} describing the image concisely for screen-reader accessibility.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: request.prompt },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      },
      this.timeoutMs,
    );
    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    const content = choices?.[0]?.message?.content ?? '';
    const usageRaw = data.usage as
      { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const parsed = extractJsonPayload(content) as { altText?: unknown; confidence?: unknown };
    if (typeof parsed.altText !== 'string' || !parsed.altText.trim()) {
      throw new AiProviderError(this.name, undefined, 'Model did not return altText');
    }
    return {
      data: {
        altText: parsed.altText.trim(),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      },
      usage: buildUsage(
        this.name,
        this.model,
        usageRaw?.prompt_tokens ?? 0,
        usageRaw?.completion_tokens ?? 0,
      ),
      provider: this.name,
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Google Gemini
// ---------------------------------------------------------------------------

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  readonly model: string;
  readonly supportsVision = true;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options?: { model?: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.model = options?.model || DEFAULT_MODELS.gemini;
    this.baseUrl = (options?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );
    this.fetchFn = options?.fetch ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const data = await postJson(
      this.fetchFn,
      this.name,
      url,
      { 'x-goog-api-key': this.apiKey },
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.2,
          maxOutputTokens: request.maxTokens ?? 2048,
          responseMimeType: 'application/json',
        },
      },
      this.timeoutMs,
    );

    const candidates = data.candidates as
      { content?: { parts?: { text?: string }[] } }[] | undefined;
    const content = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const meta = data.usageMetadata as
      { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;

    return {
      data: validateOutput(request, content, this.name),
      usage: buildUsage(
        this.name,
        this.model,
        meta?.promptTokenCount ?? 0,
        meta?.candidatesTokenCount ?? 0,
      ),
      provider: this.name,
      model: this.model,
    };
  }

  async describeImage(
    request: AiImageRequest,
  ): Promise<AiCompletionResult<{ altText: string; confidence: number }>> {
    if (!request.imageBase64) {
      throw new AiProviderError(this.name, undefined, 'Gemini vision requires image bytes');
    }
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const data = await postJson(
      this.fetchFn,
      this.name,
      url,
      { 'x-goog-api-key': this.apiKey },
      {
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${request.prompt}\nReturn JSON {"altText": string, "confidence": number}.`,
              },
              { inlineData: { mimeType: request.mimeType, data: request.imageBase64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      },
      this.timeoutMs,
    );
    const candidates = data.candidates as
      { content?: { parts?: { text?: string }[] } }[] | undefined;
    const content = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const meta = data.usageMetadata as
      { promptTokenCount?: number; candidatesTokenCount?: number } | undefined;
    const parsed = extractJsonPayload(content) as { altText?: unknown; confidence?: unknown };
    if (typeof parsed.altText !== 'string' || !parsed.altText.trim()) {
      throw new AiProviderError(this.name, undefined, 'Model did not return altText');
    }
    return {
      data: {
        altText: parsed.altText.trim(),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      },
      usage: buildUsage(
        this.name,
        this.model,
        meta?.promptTokenCount ?? 0,
        meta?.candidatesTokenCount ?? 0,
      ),
      provider: this.name,
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Anthropic Claude
// ---------------------------------------------------------------------------

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  readonly supportsVision = true;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options?: { model?: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number },
  ) {
    this.model = options?.model || DEFAULT_MODELS.anthropic;
    this.baseUrl = (options?.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.fetchFn = options?.fetch ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const schema = toAnthropicJsonSchema(request.wireSchema ?? request.schema);
    const data = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/messages`,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 2048,
        system: request.system,
        output_config: {
          format: {
            type: 'json_schema',
            schema,
          },
        },
        messages: [{ role: 'user', content: request.prompt }],
      },
      this.timeoutMs,
    );

    const blocks = data.content as { type?: string; text?: string }[] | undefined;
    const content = blocks?.find((b) => b.type === 'text')?.text ?? '';
    const usageRaw = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;

    return {
      data: validateOutput(request, content, this.name),
      usage: buildUsage(
        this.name,
        this.model,
        usageRaw?.input_tokens ?? 0,
        usageRaw?.output_tokens ?? 0,
      ),
      provider: this.name,
      model: this.model,
    };
  }

  async describeImage(
    request: AiImageRequest,
  ): Promise<AiCompletionResult<{ altText: string; confidence: number }>> {
    if (!request.imageBase64) {
      throw new AiProviderError(this.name, undefined, 'Anthropic vision requires image bytes');
    }
    const schema = toAnthropicJsonSchema(AltTextOutputSchema);
    const data = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/messages`,
      {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 300,
        system: 'Describe the image concisely for accessibility alt text.',
        output_config: {
          format: {
            type: 'json_schema',
            schema,
          },
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: request.mimeType, data: request.imageBase64 },
              },
              { type: 'text', text: request.prompt },
            ],
          },
        ],
      },
      this.timeoutMs,
    );
    const blocks = data.content as { type?: string; text?: string }[] | undefined;
    const content = blocks?.find((b) => b.type === 'text')?.text ?? '';
    const usageRaw = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    const parsed = extractJsonPayload(content) as { altText?: unknown; confidence?: unknown };
    if (typeof parsed.altText !== 'string' || !parsed.altText.trim()) {
      throw new AiProviderError(this.name, undefined, 'Model did not return altText');
    }
    return {
      data: {
        altText: parsed.altText.trim(),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      },
      usage: buildUsage(
        this.name,
        this.model,
        usageRaw?.input_tokens ?? 0,
        usageRaw?.output_tokens ?? 0,
      ),
      provider: this.name,
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Ollama (local models)
// ---------------------------------------------------------------------------

export class OllamaProvider implements AiProvider {
  readonly name = 'ollama' as const;
  readonly model: string;
  readonly supportsVision = true;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options?: {
    model?: string;
    baseUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
  }) {
    this.model = options?.model || DEFAULT_MODELS.ollama;
    this.baseUrl = (options?.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.fetchFn = options?.fetch ?? fetch;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const data = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/api/chat`,
      {},
      {
        model: this.model,
        stream: false,
        format: 'json',
        options: { temperature: request.temperature ?? 0.2 },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
      },
      this.timeoutMs,
    );
    const msg = data.message as { content?: string } | undefined;
    const content = msg?.content ?? '';
    const inTokens = typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : 0;
    const outTokens = typeof data.eval_count === 'number' ? data.eval_count : 0;

    return {
      data: validateOutput(request, content, this.name),
      usage: buildUsage(this.name, this.model, inTokens, outTokens),
      provider: this.name,
      model: this.model,
    };
  }

  async describeImage(
    request: AiImageRequest,
  ): Promise<AiCompletionResult<{ altText: string; confidence: number }>> {
    if (!request.imageBase64) {
      throw new AiProviderError(this.name, undefined, 'Ollama vision requires image bytes');
    }
    const data = await postJson(
      this.fetchFn,
      this.name,
      `${this.baseUrl}/api/chat`,
      {},
      {
        model: this.model,
        stream: false,
        format: 'json',
        messages: [
          {
            role: 'user',
            content: `${request.prompt}\nReturn JSON {"altText": string, "confidence": number}.`,
            images: [request.imageBase64],
          },
        ],
      },
      this.timeoutMs,
    );
    const msg = data.message as { content?: string } | undefined;
    const parsed = extractJsonPayload(msg?.content ?? '') as {
      altText?: unknown;
      confidence?: unknown;
    };
    if (typeof parsed.altText !== 'string' || !parsed.altText.trim()) {
      throw new AiProviderError(this.name, undefined, 'Model did not return altText');
    }
    return {
      data: {
        altText: parsed.altText.trim(),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.75,
      },
      usage: buildUsage(
        this.name,
        this.model,
        typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : 0,
        typeof data.eval_count === 'number' ? data.eval_count : 0,
      ),
      provider: this.name,
      model: this.model,
    };
  }
}

// ---------------------------------------------------------------------------
// Mock Provider (tests & local development)
// ---------------------------------------------------------------------------

export type MockHandler = (request: AiCompletionRequest<unknown>) => unknown;

export class MockAiProvider implements AiProvider {
  readonly name = 'mock' as const;
  readonly model = 'mock-model';
  readonly supportsVision = true;

  constructor(
    private readonly handler: MockHandler,
    private readonly imageHandler?: (request: AiImageRequest) => {
      altText: string;
      confidence: number;
    },
  ) {}

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const raw = await Promise.resolve(this.handler(request as AiCompletionRequest<unknown>));
    const parsed = request.schema.parse(raw);
    const inputTokens = Math.ceil((request.system.length + request.prompt.length) / 4);
    const outputTokens = Math.ceil(JSON.stringify(parsed).length / 4);
    return {
      data: parsed,
      usage: buildUsage(this.name, this.model, inputTokens, outputTokens),
      provider: this.name,
      model: this.model,
    };
  }

  async describeImage(
    request: AiImageRequest,
  ): Promise<AiCompletionResult<{ altText: string; confidence: number }>> {
    const res = this.imageHandler
      ? await Promise.resolve(this.imageHandler(request))
      : { altText: 'Historical photograph described by mock AI', confidence: 0.9 };
    return {
      data: res,
      usage: buildUsage(this.name, this.model, 120, 24),
      provider: this.name,
      model: this.model,
    };
  }
}

export function createAiProvider(config: AiProviderConfig): AiProvider {
  switch (config.provider) {
    case 'openai':
      if (!config.apiKey) throw new Error('OpenAI API key is required');
      return new OpenAiProvider(config.apiKey, config);
    case 'gemini':
      if (!config.apiKey) throw new Error('Gemini API key is required');
      return new GeminiProvider(config.apiKey, config);
    case 'anthropic':
      if (!config.apiKey) throw new Error('Anthropic API key is required');
      return new AnthropicProvider(config.apiKey, config);
    case 'ollama':
      return new OllamaProvider(config);
    case 'mock':
      return new MockAiProvider(() => ({}));
  }
}
