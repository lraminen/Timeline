import { describe, it, expect } from 'vitest';
import type { Timeline } from '@chronicle/schema';
import { detectDeterministicConflicts, detectTimelineConflicts } from '../conflicts.js';
import { MockAiProvider } from '../providers.js';

const sampleTimeline: Timeline = {
  schemaVersion: '1.0.0',
  id: 'tl-1',
  title: 'Test Timeline',
  eras: [{ id: 'era-1', title: '1960s', start: '1960-01-01', end: '1969-12-31' }],
  settings: { layout: 'vertical', theme: 'light', locale: 'en' },
  events: [
    {
      id: 'e1',
      title: 'Apollo 11',
      date: { start: '1969-07-20', end: '1969-07-10' }, // invalid range
      media: [],
      tags: [],
      era: 'era-1',
    },
    {
      id: 'e2',
      title: 'Sputnik',
      date: { start: '1957-10-04' },
      media: [],
      tags: [],
      era: 'era-1', // outside era-1
    },
    {
      id: 'e3',
      title: 'Moon Landing',
      date: { start: '1969-07-20' },
      media: [],
      tags: [],
    },
    {
      id: 'e4',
      title: 'Moon Landing!',
      date: { start: '1969-07-20' },
      media: [],
      tags: [],
    },
  ],
};

describe('conflict detection', () => {
  it('flags invalid ranges, era mismatches, and duplicates deterministically', () => {
    const conflicts = detectDeterministicConflicts(sampleTimeline);
    const kinds = conflicts.map((c) => c.kind);
    expect(kinds).toContain('invalid_range');
    expect(kinds).toContain('era_mismatch');
    expect(kinds).toContain('duplicate_event');
    expect(conflicts.every((c) => !c.aiGenerated)).toBe(true);
  });

  it('merges AI semantic contradiction checks with deterministic conflicts', async () => {
    const provider = new MockAiProvider(() => ({
      conflicts: [
        {
          eventIds: ['e2', 'e3'],
          severity: 'warning',
          message: 'Claim in e3 contradicts timeline of e2.',
          suggestion: 'Verify launch date.',
        },
      ],
    }));

    const result = await detectTimelineConflicts(sampleTimeline, provider);
    expect(result.aiGenerated).toBe(true);
    expect(result.conflicts.some((c) => c.kind === 'semantic_contradiction' && c.aiGenerated)).toBe(
      true,
    );
    expect(result.conflicts.some((c) => c.kind === 'invalid_range' && !c.aiGenerated)).toBe(true);
  });
});
