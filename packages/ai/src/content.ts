import { z } from 'zod';
import { AiProviderError } from './providers.js';
import type { AiProvider, AltTextSuggestion, SummarySuggestion } from './types.js';

const SummaryResponseSchema = z.object({
  summary: z.string().min(1),
});

/**
 * Generates a concise summary suggestion for a long event description.
 * Never alters the timeline event directly — intended for human review.
 */
export async function suggestEventSummary(
  input: { eventId?: string; title: string; body: string; maxLength?: number },
  provider: AiProvider,
): Promise<SummarySuggestion> {
  const cleanBody = input.body.trim();
  if (!cleanBody) {
    throw new Error('Event description is empty; nothing to summarize.');
  }
  const targetChars = Math.max(80, Math.min(600, input.maxLength ?? 220));

  const res = await provider.completeStructured({
    schemaName: 'EventSummary',
    schema: SummaryResponseSchema,
    system: [
      'Summarize the timeline event description concisely while preserving key dates, names, and facts.',
      `Aim for roughly ${String(targetChars)} characters or fewer (1-2 crisp sentences).`,
      'Return strictly JSON: { "summary": string }.',
    ].join(' '),
    prompt: `Event title: ${input.title}\n\nDescription:\n${cleanBody}`,
    maxTokens: 400,
    temperature: 0.2,
  });

  const summary = res.data.summary.trim();
  return {
    ...(input.eventId ? { eventId: input.eventId } : {}),
    summary,
    originalLength: cleanBody.length,
    summaryLength: summary.length,
    usage: res.usage,
    provider: provider.name,
    model: provider.model,
    aiGenerated: true,
  };
}

/**
 * Generates descriptive accessibility alt text for an image using a multimodal
 * AI provider. Intended strictly as a human-reviewed suggestion.
 */
export async function suggestImageAltText(
  input: {
    imageBase64?: string;
    imageUrl?: string;
    mimeType: string;
    eventTitle?: string;
    caption?: string;
  },
  provider: AiProvider,
): Promise<AltTextSuggestion> {
  if (!provider.describeImage || !provider.supportsVision) {
    throw new AiProviderError(
      provider.name,
      undefined,
      `Provider "${provider.name}" does not support image analysis for alt text generation.`,
    );
  }

  const contextParts = [
    input.eventTitle ? `Timeline event: ${input.eventTitle}` : '',
    input.caption ? `Image caption: ${input.caption}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const prompt = [
    'Write concise, objective accessibility alt text (1-2 sentences, under 180 characters) describing what is visible in this image.',
    'Do not start with "Image of" or "Picture of".',
    contextParts,
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await provider.describeImage({
    imageBase64: input.imageBase64,
    imageUrl: input.imageUrl,
    mimeType: input.mimeType,
    prompt,
    maxTokens: 250,
  });

  return {
    altText: res.data.altText,
    confidence: Math.max(0, Math.min(1, res.data.confidence)),
    usage: res.usage,
    provider: provider.name,
    model: provider.model,
    aiGenerated: true,
  };
}
