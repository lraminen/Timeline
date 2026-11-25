import { compareDates, type Timeline, type TimelineEvent } from '@chronicle/schema';
import { z } from 'zod';
import type { AiProvider, ConflictDetectionResult, TimelineConflict } from './types.js';

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Deterministic structural and chronological conflict checks on a Timeline.
 * Uses hash indexing for duplicates and sorted per-group sweep for overlaps ($O(n \log n)$).
 */
export function detectDeterministicConflicts(timeline: Timeline): TimelineConflict[] {
  const conflicts: TimelineConflict[] = [];
  const erasById = new Map(timeline.eras.map((e) => [e.id, e]));
  const byTitleDate = new Map<string, TimelineEvent[]>();
  const rangedByGroup = new Map<string, { event: TimelineEvent; normTitle: string }[]>();

  // 1. Event range, era bounds, and bucket indexing in a single O(n) pass
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

    const norm = normaliseTitle(evt.title);
    if (norm) {
      const key = `${evt.date.start}::${norm}`;
      const bucket = byTitleDate.get(key);
      if (bucket) bucket.push(evt);
      else byTitleDate.set(key, [evt]);
    }

    if (evt.group && evt.date.end) {
      const list = rangedByGroup.get(evt.group);
      const entry = { event: evt, normTitle: norm };
      if (list) list.push(entry);
      else rangedByGroup.set(evt.group, [entry]);
    }
  }

  // 2. Duplicate events (O(n) for typical timelines via title+start bucket map)
  const duplicatePairs = new Set<string>();
  for (const bucket of byTitleDate.values()) {
    if (bucket.length < 2) continue;
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i];
      if (!a) continue;
      for (let j = i + 1; j < bucket.length; j++) {
        const b = bucket[j];
        if (!b) continue;
        duplicatePairs.add(`${a.id}::${b.id}`);
        duplicatePairs.add(`${b.id}::${a.id}`);
        conflicts.push({
          id: `dup:${a.id}:${b.id}`,
          kind: 'duplicate_event',
          severity: 'warning',
          eventIds: [a.id, b.id],
          message: `Possible duplicate event: “${a.title}” and “${b.title}” share the same title and start date (${a.date.start}).`,
          suggestion: 'Merge the two events or clarify their titles.',
          aiGenerated: false,
        });
      }
    }
  }

  // 3. Per-group range overlaps via sorted sweep-line (O(n log n))
  for (const [group, entries] of rangedByGroup) {
    if (entries.length < 2) continue;
    entries.sort((a, b) => compareDates(a.event.date, b.event.date));
    let active: { event: TimelineEvent; normTitle: string }[] = [];

    for (const curr of entries) {
      const currStart = curr.event.date;
      active = active.filter((prev) => {
        const prevEnd = prev.event.date.end ?? prev.event.date.start;
        return compareDates({ start: prevEnd }, currStart) >= 0;
      });
      for (const prev of active) {
        if (duplicatePairs.has(`${prev.event.id}::${curr.event.id}`)) continue;
        conflicts.push({
          id: `overlap:${prev.event.id}:${curr.event.id}`,
          kind: 'overlapping_events',
          severity: 'warning',
          eventIds: [prev.event.id, curr.event.id],
          message: `Events “${prev.event.title}” and “${curr.event.title}” in group “${group}” have overlapping date ranges.`,
          aiGenerated: false,
        });
      }
      active.push(curr);
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
