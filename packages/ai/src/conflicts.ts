import { compareDates, type Timeline } from '@chronicle/schema';
import { z } from 'zod';
import type { AiProvider, ConflictDetectionResult, TimelineConflict } from './types.js';

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function datesOverlap(
  aStart: string,
  aEnd: string | undefined,
  bStart: string,
  bEnd: string | undefined,
): boolean {
  const effAEnd = aEnd ?? aStart;
  const effBEnd = bEnd ?? bStart;
  return (
    compareDates({ start: aStart }, { start: effBEnd }) <= 0 &&
    compareDates({ start: bStart }, { start: effAEnd }) <= 0
  );
}

/**
 * Deterministic structural and chronological conflict checks on a Timeline.
 * Always runs locally without network or LLM calls.
 */
export function detectDeterministicConflicts(timeline: Timeline): TimelineConflict[] {
  const conflicts: TimelineConflict[] = [];
  const erasById = new Map(timeline.eras.map((e) => [e.id, e]));

  // 1. Event range & era bounds
  for (const evt of timeline.events) {
    if (evt.date.end && compareDates({ start: evt.date.end }, evt.date) < 0) {
      conflicts.push({
        id: `range:${evt.id}`,
        kind: 'invalid_range',
        severity: 'error',
        eventIds: [evt.id],
        message: `“${evt.title}” has an end date (${evt.date.end}) earlier than its start date (${evt.date.start}).`,
        suggestion: 'Swap start and end dates or remove the end date.',
        aiGenerated: false,
      });
    }

    if (evt.era) {
      const era = erasById.get(evt.era);
      if (era) {
        const beforeEra = compareDates(evt.date, { start: era.start }) < 0;
        const afterEra =
          compareDates({ start: evt.date.end ?? evt.date.start }, { start: era.end }) > 0;
        if (beforeEra || afterEra) {
          conflicts.push({
            id: `era:${evt.id}:${era.id}`,
            kind: 'era_mismatch',
            severity: 'warning',
            eventIds: [evt.id],
            message: `“${evt.title}” (${evt.date.start}) falls outside its assigned era “${era.title}” (${era.start}–${era.end}).`,
            suggestion: `Update the event date, change its era, or widen “${era.title}”.`,
            aiGenerated: false,
          });
        }
      }
    }
  }

  // 2. Duplicate / overlapping events
  for (let i = 0; i < timeline.events.length; i++) {
    const a = timeline.events[i];
    if (!a) continue;
    const normA = normaliseTitle(a.title);
    for (let j = i + 1; j < timeline.events.length; j++) {
      const b = timeline.events[j];
      if (!b) continue;
      const normB = normaliseTitle(b.title);

      if (normA && normA === normB && a.date.start === b.date.start) {
        conflicts.push({
          id: `dup:${a.id}:${b.id}`,
          kind: 'duplicate_event',
          severity: 'warning',
          eventIds: [a.id, b.id],
          message: `Possible duplicate event: “${a.title}” and “${b.title}” share the same title and start date (${a.date.start}).`,
          suggestion: 'Merge the two events or clarify their titles.',
          aiGenerated: false,
        });
      } else if (
        a.group &&
        b.group &&
        a.group === b.group &&
        a.date.end &&
        b.date.end &&
        datesOverlap(a.date.start, a.date.end, b.date.start, b.date.end)
      ) {
        conflicts.push({
          id: `overlap:${a.id}:${b.id}`,
          kind: 'overlapping_events',
          severity: 'warning',
          eventIds: [a.id, b.id],
          message: `Events “${a.title}” and “${b.title}” in group “${a.group}” have overlapping date ranges.`,
          aiGenerated: false,
        });
      }
    }
  }

  return conflicts;
}

const SemanticConflictsSchema = z.object({
  conflicts: z
    .array(
      z.object({
        eventIds: z.array(z.string()).min(1),
        severity: z.enum(['error', 'warning']).default('warning'),
        message: z.string().min(1),
        suggestion: z.string().optional(),
      }),
    )
    .default([]),
});

/**
 * Runs deterministic conflict checks, optionally followed by LLM semantic
 * contradiction analysis across event descriptions and dates.
 */
export async function detectTimelineConflicts(
  timeline: Timeline,
  provider?: AiProvider,
): Promise<ConflictDetectionResult> {
  const deterministic = detectDeterministicConflicts(timeline);
  if (!provider || timeline.events.length < 2) {
    return { conflicts: deterministic, aiGenerated: false };
  }

  const validIds = new Set(timeline.events.map((e) => e.id));
  const compactEvents = timeline.events.slice(0, 60).map((e) => ({
    id: e.id,
    title: e.title,
    start: e.date.start,
    end: e.date.end,
    body: e.body?.slice(0, 400),
  }));

  const res = await provider.completeStructured({
    schemaName: 'SemanticConflicts',
    schema: SemanticConflictsSchema,
    system: [
      'You are an editor checking a historical or project timeline for factual, causal, or chronological contradictions.',
      'Only flag genuine contradictions (e.g., an event referencing a person after their death, reversed cause/effect, contradictory dates for the same milestone). Do not flag normal concurrent events.',
      'Return JSON: { "conflicts": [{ "eventIds": string[], "severity": "warning"|"error", "message": string, "suggestion"?: string }] }.',
    ].join(' '),
    prompt: `Timeline: ${timeline.title}\nEvents:\n${JSON.stringify(compactEvents)}`,
    maxTokens: 1200,
    temperature: 0.1,
  });

  const semantic: TimelineConflict[] = res.data.conflicts
    .filter((c) => c.eventIds.some((id) => validIds.has(id)))
    .map((c, idx) => ({
      id: `ai-conflict:${String(idx + 1)}`,
      kind: 'semantic_contradiction' as const,
      severity: c.severity,
      eventIds: c.eventIds.filter((id) => validIds.has(id)),
      message: c.message,
      suggestion: c.suggestion,
      aiGenerated: true,
    }));

  return {
    conflicts: [...deterministic, ...semantic],
    usage: res.usage,
    aiGenerated: semantic.length > 0,
  };
}
