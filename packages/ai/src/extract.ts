import { TimelineDateSchema, TimelineLocationSchema } from '@chronicle/schema';
import { z } from 'zod';
import { emptyUsage, mergeUsage } from './providers.js';
import type {
  AiProvider,
  AiUsage,
  ExtractedEventSuggestion,
  ExtractionOptions,
  ExtractionResult,
} from './types.js';

export interface TextChunk {
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

/** Strips HTML tags, head, title, scripts, styles, and entities into readable plain text. */
export function parseHtmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ');

  const withBreaks = withoutScripts
    .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|section|article)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  const decoded = withBreaks
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => {
      const code = Number(n);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
    });

  return decoded
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Splits a document into overlapping character chunks aligned to paragraph or
 * sentence boundaries so large documents can be batch-processed without
 * severing event context.
 */
export function chunkDocument(
  text: string,
  chunkSize = 6000,
  overlap = 400,
): TextChunk[] {
  const clean = text.trim();
  if (!clean) return [];
  const safeSize = Math.max(500, chunkSize);
  const safeOverlap = Math.max(0, Math.min(overlap, Math.floor(safeSize / 2)));

  if (clean.length <= safeSize) {
    return [{ index: 0, text: clean, startOffset: 0, endOffset: clean.length }];
  }

  const chunks: TextChunk[] = [];
  let cursor = 0;
  let index = 0;

  while (cursor < clean.length) {
    let end = Math.min(clean.length, cursor + safeSize);
    if (end < clean.length) {
      // Prefer breaking on a paragraph or sentence boundary in the last 25% of the chunk.
      const windowStart = cursor + Math.floor(safeSize * 0.75);
      const slice = clean.slice(windowStart, end);
      const paraBreak = slice.lastIndexOf('\n\n');
      const sentenceBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
      const bestRel = paraBreak >= 0 ? paraBreak + 2 : sentenceBreak >= 0 ? sentenceBreak + 2 : -1;
      if (bestRel > 0) {
        end = windowStart + bestRel;
      }
    }

    chunks.push({
      index,
      text: clean.slice(cursor, end),
      startOffset: cursor,
      endOffset: end,
    });

    if (end >= clean.length) break;
    cursor = Math.max(cursor + 1, end - safeOverlap);
    index += 1;
  }

  return chunks;
}

/** Finds the offset of a quote in the source chunk (exact first, then whitespace-collapsed). */
export function locateCitation(
  sourceText: string,
  quote: string,
  baseOffset = 0,
): { startOffset?: number; endOffset?: number } {
  const trimmed = quote.trim();
  if (!trimmed) return {};
  const directIdx = sourceText.indexOf(trimmed);
  if (directIdx !== -1) {
    return {
      startOffset: baseOffset + directIdx,
      endOffset: baseOffset + directIdx + trimmed.length,
    };
  }
  const lowerIdx = sourceText.toLowerCase().indexOf(trimmed.toLowerCase());
  if (lowerIdx !== -1) {
    return {
      startOffset: baseOffset + lowerIdx,
      endOffset: baseOffset + lowerIdx + trimmed.length,
    };
  }
  return {};
}

const RawExtractedEventSchema = z.object({
  title: z.string().min(1),
  date: TimelineDateSchema,
  body: z.string().optional(),
  tags: z.array(z.string()).default([]),
  location: TimelineLocationSchema.optional().nullable(),
  citation: z.object({
    quote: z.string().min(1),
    section: z.string().optional(),
  }),
  confidence: z.number().min(0).max(1).default(0.75),
});

const ChunkExtractionResponseSchema = z.object({
  documentTitle: z.string().optional(),
  events: z.array(RawExtractedEventSchema).default([]),
});

function normaliseKey(title: string, start: string): string {
  return `${start.trim()}::${title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()}`;
}

export function deduplicateExtractedEvents(
  items: ExtractedEventSuggestion[],
): ExtractedEventSuggestion[] {
  const seen = new Map<string, ExtractedEventSuggestion>();
  for (const item of items) {
    const key = normaliseKey(item.title, item.date.start);
    const existing = seen.get(key);
    if (!existing || item.confidence > existing.confidence) {
      seen.set(key, item);
    }
  }
  return Array.from(seen.values());
}

/**
 * Extracts structured timeline events with citations and confidence scores
 * from a document using the configured LLM provider. Supports large documents
 * via overlapping chunked batch extraction.
 */
export async function extractEventsFromDocument(
  documentText: string,
  provider: AiProvider,
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const clean = documentText.trim();
  if (!clean) {
    return {
      events: [],
      documentTitle: options.documentTitle,
      totalChunks: 0,
      processedChunks: 0,
      truncated: false,
      usage: emptyUsage(),
      provider: provider.name,
      model: provider.model,
      aiGenerated: true,
    };
  }

  const allChunks = chunkDocument(clean, options.chunkSize ?? 6000, options.chunkOverlap ?? 400);
  const maxChunks = options.maxChunks ?? 12;
  const chunksToProcess = allChunks.slice(0, maxChunks);
  const truncated = allChunks.length > chunksToProcess.length;
  const maxEvents = options.maxEvents ?? 100;

  let usage: AiUsage = emptyUsage();
  let detectedTitle = options.documentTitle;
  const collected: ExtractedEventSuggestion[] = [];
  let candidateCounter = 0;

  for (let i = 0; i < chunksToProcess.length; i++) {
    const chunk = chunksToProcess[i];
    if (!chunk) continue;

    const res = await provider.completeStructured({
      schemaName: 'ExtractedEvents',
      schema: ChunkExtractionResponseSchema,
      system: [
        'Extract chronological events from the provided document excerpt for a historical/project timeline.',
        'For each event return:',
        '- title: concise headline',
        '- date: { "start": "YYYY" | "YYYY-MM" | "YYYY-MM-DD" (use "-YYYY" for BCE), "end"?: string, "approximate"?: boolean, "uncertain"?: boolean, "displayOverride"?: string }',
        '- body: brief 1-3 sentence neutral Markdown description grounded strictly in the text',
        '- tags: up to 5 short lowercase topic tags',
        '- citation: { "quote": verbatim supporting sentence/phrase from the excerpt, "section"?: section heading if known }',
        '- confidence: number from 0.0 to 1.0 reflecting date/fact certainty in the text',
        'Do NOT invent dates or facts not present in the source text. Skip undated background prose.',
        'Return JSON: { "documentTitle"?: string, "events": [...] }.',
      ].join('\n'),
      prompt: `Chunk ${String(i + 1)} of ${String(chunksToProcess.length)}:\n\n${chunk.text}`,
      maxTokens: 3000,
      temperature: 0.1,
    });

    usage = mergeUsage(usage, res.usage);
    if (!detectedTitle && res.data.documentTitle?.trim()) {
      detectedTitle = res.data.documentTitle.trim();
    }

    for (const raw of res.data.events) {
      const offsets = locateCitation(chunk.text, raw.citation.quote, chunk.startOffset);
      candidateCounter += 1;
      collected.push({
        id: `ai-cand-${String(candidateCounter)}`,
        title: raw.title.trim(),
        date: raw.date,
        body: raw.body?.trim() || undefined,
        tags: raw.tags.map((t) => t.trim()).filter(Boolean).slice(0, 8),
        ...(raw.location ? { location: raw.location } : {}),
        citation: {
          quote: raw.citation.quote.trim(),
          ...(raw.citation.section ? { section: raw.citation.section.trim() } : {}),
          ...offsets,
        },
        confidence: Math.max(0, Math.min(1, raw.confidence)),
        aiGenerated: true,
      });
    }

    options.onProgress?.(i + 1, chunksToProcess.length);
  }

  const deduped = deduplicateExtractedEvents(collected).slice(0, maxEvents);

  return {
    events: deduped,
    documentTitle: detectedTitle,
    totalChunks: allChunks.length,
    processedChunks: chunksToProcess.length,
    truncated,
    usage,
    provider: provider.name,
    model: provider.model,
    aiGenerated: true,
  };
}
