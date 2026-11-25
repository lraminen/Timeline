export type {
  AiProviderName,
  AiUsage,
  AiCompletionResult,
  AiCompletionRequest,
  AiImageRequest,
  AiProvider,
  AiProviderConfig,
  EventCitation,
  ExtractedEventSuggestion,
  ExtractionOptions,
  ExtractionResult,
  DateNormalizationResult,
  ConflictKind,
  ConflictSeverity,
  TimelineConflict,
  ConflictDetectionResult,
  SummarySuggestion,
  AltTextSuggestion,
  CandidateEventInput,
} from './types.js';

export { EventCitationSchema } from './types.js';

export {
  OpenAiProvider,
  GeminiProvider,
  AnthropicProvider,
  OllamaProvider,
  MockAiProvider,
  AiProviderError,
  createAiProvider,
  estimateCostMicros,
  emptyUsage,
  mergeUsage,
  extractJsonPayload,
  type MockHandler,
} from './providers.js';

export { normalizeNaturalDateDeterministic, normalizeNaturalDate } from './date-normalizer.js';

export { detectDeterministicConflicts, detectTimelineConflicts } from './conflicts.js';

export {
  chunkDocument,
  parseHtmlToText,
  locateCitation,
  deduplicateExtractedEvents,
  extractEventsFromDocument,
  type TextChunk,
} from './extract.js';

export { suggestEventSummary, suggestImageAltText } from './content.js';
