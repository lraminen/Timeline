import type { TimelineDate, TimelineEvent, TimelineLocation } from '@chronicle/schema';
import { z } from 'zod';

export type AiProviderName = 'openai' | 'gemini' | 'anthropic' | 'ollama' | 'mock';

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Estimated cost in USD micro-dollars (1_000_000 = $1.00). */
  estimatedCostMicros: number;
}

export interface AiCompletionResult<T> {
  data: T;
  usage: AiUsage;
  provider: AiProviderName;
  model: string;
}

export interface AiCompletionRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Optional simpler JSON-schema wire model for providers supporting constrained decoding. */
  wireSchema?: z.ZodType<unknown, z.ZodTypeDef, unknown>;
  schemaName: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AiImageRequest {
  /** Base64-encoded image bytes (without data URL prefix) or an https URL. */
  imageBase64?: string;
  mimeType: string;
  imageUrl?: string;
  prompt: string;
  maxTokens?: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly model: string;
  readonly supportsVision: boolean;
  completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>>;
  describeImage?(
    request: AiImageRequest,
  ): Promise<AiCompletionResult<{ altText: string; confidence: number }>>;
}

export interface AiProviderConfig {
  provider: AiProviderName;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Extraction types
// ---------------------------------------------------------------------------

export const EventCitationSchema = z.object({
  quote: z.string().min(1).describe('Exact or close verbatim quote supporting this event.'),
  section: z.string().optional().describe('Heading or section label if present.'),
  startOffset: z.number().int().nonnegative().optional(),
  endOffset: z.number().int().nonnegative().optional(),
});

export type EventCitation = z.infer<typeof EventCitationSchema>;

export interface ExtractedEventSuggestion {
  /** Temporary candidate ID used during human review before acceptance. */
  id: string;
  title: string;
  date: TimelineDate;
  body?: string;
  tags: string[];
  location?: TimelineLocation;
  citation: EventCitation;
  /** Model confidence score in [0, 1]. */
  confidence: number;
  /** Explicit provenance flag; AI outputs are never silently published. */
  aiGenerated: true;
}

export interface ExtractionOptions {
  maxEvents?: number;
  chunkSize?: number;
  chunkOverlap?: number;
  maxChunks?: number;
  documentTitle?: string;
  onProgress?: (done: number, total: number) => void;
  onChunkUsage?: (usage: AiUsage) => void | Promise<void>;
}

export interface ExtractionResult {
  events: ExtractedEventSuggestion[];
  documentTitle?: string;
  /** Extracted normalized source text returned so UI citation inspection works for files & URLs. */
  sourceText?: string;
  /** Count of malformed candidate events dropped during per-event schema validation. */
  droppedEvents?: number;
  totalChunks: number;
  processedChunks: number;
  truncated: boolean;
  usage: AiUsage;
  provider: AiProviderName;
  model: string;
  aiGenerated: true;
}

// ---------------------------------------------------------------------------
// Date normalization types
// ---------------------------------------------------------------------------

export interface DateNormalizationResult {
  input: string;
  date: TimelineDate | null;
  confidence: number;
  reasoning: string;
  source: 'deterministic' | 'ai';
  aiGenerated: boolean;
  usage?: AiUsage;
}

// ---------------------------------------------------------------------------
// Conflict detection types
// ---------------------------------------------------------------------------

export type ConflictKind =
  | 'invalid_range'
  | 'era_mismatch'
  | 'duplicate_event'
  | 'overlapping_events'
  | 'semantic_contradiction';

export type ConflictSeverity = 'error' | 'warning';

export interface TimelineConflict {
  id: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  eventIds: string[];
  message: string;
  suggestion?: string;
  aiGenerated: boolean;
}

export interface ConflictDetectionResult {
  conflicts: TimelineConflict[];
  usage?: AiUsage;
  aiGenerated: boolean;
}

// ---------------------------------------------------------------------------
// Summary & Alt-text suggestions
// ---------------------------------------------------------------------------

export interface SummarySuggestion {
  eventId?: string;
  summary: string;
  originalLength: number;
  summaryLength: number;
  usage: AiUsage;
  provider: AiProviderName;
  model: string;
  aiGenerated: true;
}

export interface AltTextSuggestion {
  altText: string;
  confidence: number;
  usage: AiUsage;
  provider: AiProviderName;
  model: string;
  aiGenerated: true;
}

export type CandidateEventInput = Pick<
  TimelineEvent,
  'id' | 'title' | 'date' | 'body' | 'tags' | 'era' | 'group'
>;
