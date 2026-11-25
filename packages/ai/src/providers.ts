import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiImageRequest,
  AiProvider,
  AiProviderConfig,
  AiProviderName,
  AiUsage,
} from './types.js';

const DEFAULT_MODELS: Record<AiProviderName, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.5-flash',
  anthropic: 'claude-3-5-haiku-latest',
  ollama: 'llama3.2',
  mock: 'mock-model',
};

/** Rough per-1M-token USD prices [inputUsd, outputUsd] for budget tracking. */
const MODEL_PRICING: Record<string, [number, number]> = {
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10.0],
  'gemini-2.5-flash': [0.15, 0.6],
  'gemini-2.5-pro': [1.25, 10.0],
  'claude-3-5-haiku-latest': [0.8, 4.0],
  'claude-3-5-sonnet-latest': [3.0, 15.0],
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

function validateOutput<T>(request: AiCompletionRequest<T>, rawText: string, provider: AiProviderName): T {
  let parsedJson: unknown;
  try {
    parsedJson = extractJsonPayload(rawText);
  } catch (err) {
    throw new AiProviderError(
      provider,
      undefined,
      `Failed to parse JSON from ${provider}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const checked = request.schema.safeParse(parsedJson);
  if (!checked.success) {
    const msg = checked.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AiProviderError(provider, undefined, `Model output failed schema validation: ${msg}`);
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
): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new AiProviderError(
      provider,
      res.status,
      `${provider} API error (${String(res.status)}): ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  readonly model: string;
  readonly supportsVision = true;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly apiKey: string,
    options?: { model?: string; baseUrl?: string; fetch?: typeof fetch },
  ) {
    this.model = options?.model || DEFAULT_MODELS.openai;
    this.baseUrl = (options?.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.fetchFn = options?.fetch ?? fetch;
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
    );

    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    const content = choices?.[0]?.message?.content ?? '';
    const usageRaw = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
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
    );
    const choices = data.choices as { message?: { content?: string } }[] | undefined;
    const content = choices?.[0]?.message?.content ?? '';
    const usageRaw = data.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
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

  constructor(
    private readonly apiKey: string,
    options?: { model?: string; baseUrl?: string; fetch?: typeof fetch },
  ) {
    this.model = options?.model || DEFAULT_MODELS.gemini;
    this.baseUrl = (options?.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(
      /\/$/,
      '',
    );
    this.fetchFn = options?.fetch ?? fetch;
  }

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const data = await postJson(
      this.fetchFn,
      this.name,
      url,
      {},
      {
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? 0.2,
          maxOutputTokens: request.maxTokens ?? 2048,
          responseMimeType: 'application/json',
        },
      },
    );

    const candidates = data.candidates as
      | { content?: { parts?: { text?: string }[] } }[]
      | undefined;
    const content = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const meta = data.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number }
      | undefined;

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
    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const data = await postJson(
      this.fetchFn,
      this.name,
      url,
      {},
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
    );
    const candidates = data.candidates as
      | { content?: { parts?: { text?: string }[] } }[]
      | undefined;
    const content = candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const meta = data.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number }
      | undefined;
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

  constructor(
    private readonly apiKey: string,
    options?: { model?: string; baseUrl?: string; fetch?: typeof fetch },
  ) {
    this.model = options?.model || DEFAULT_MODELS.anthropic;
    this.baseUrl = (options?.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    this.fetchFn = options?.fetch ?? fetch;
  }

  async completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
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
        temperature: request.temperature ?? 0.2,
        system: `${request.system}\nRespond with ONLY valid JSON.`,
        messages: [{ role: 'user', content: request.prompt }],
      },
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
        temperature: 0.2,
        system: 'Return ONLY JSON {"altText": string, "confidence": number} for accessibility alt text.',
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

  constructor(options?: { model?: string; baseUrl?: string; fetch?: typeof fetch }) {
    this.model = options?.model || DEFAULT_MODELS.ollama;
    this.baseUrl = (options?.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.fetchFn = options?.fetch ?? fetch;
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
