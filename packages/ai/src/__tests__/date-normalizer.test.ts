import { describe, it, expect } from 'vitest';
import {
  normalizeNaturalDate,
  normalizeNaturalDateDeterministic,
} from '../date-normalizer.js';
import { MockAiProvider } from '../providers.js';

describe('date-normalizer', () => {
  it('parses seasonal expressions like "the summer of \'69"', () => {
    const res = normalizeNaturalDateDeterministic("the summer of '69");
    expect(res.source).toBe('deterministic');
    expect(res.aiGenerated).toBe(false);
    expect(res.date).toEqual({
      start: '1969-06',
      end: '1969-08',
      approximate: true,
      displayOverride: 'Summer 1969',
    });
  });

  it('parses century modifiers like "early 20th century" and "5th century BCE"', () => {
    const early20 = normalizeNaturalDateDeterministic('early 20th century');
    expect(early20.date?.start).toBe('1901');
    expect(early20.date?.end).toBe('1930');
    expect(early20.date?.approximate).toBe(true);

    const bce5 = normalizeNaturalDateDeterministic('5th century BCE');
    expect(bce5.date?.start).toBe('-0500');
    expect(bce5.date?.end).toBe('-0401');
    expect(bce5.date?.approximate).toBe(true);
  });

  it('parses decades, quarters, and BCE years', () => {
    const dec = normalizeNaturalDateDeterministic('late 1920s');
    expect(dec.date?.start).toBe('1927');
    expect(dec.date?.end).toBe('1929');
    expect(dec.date?.approximate).toBe(true);

    const q = normalizeNaturalDateDeterministic('Q3 2024');
    expect(q.date?.start).toBe('2024-07');
    expect(q.date?.end).toBe('2024-09');

    const bce = normalizeNaturalDateDeterministic('circa 44 BC?');
    expect(bce.date?.start).toBe('-0044');
    expect(bce.date?.approximate).toBe(true);
    expect(bce.date?.uncertain).toBe(true);
  });

  it('parses English month dates', () => {
    const res = normalizeNaturalDateDeterministic('July 20, 1969');
    expect(res.date?.start).toBe('1969-07-20');
    expect(res.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to LLM only when deterministic parsing cannot resolve', async () => {
    const mock = new MockAiProvider(() => ({
      start: '1945-05-08',
      approximate: false,
      uncertain: false,
      displayOverride: 'VE Day',
      confidence: 0.93,
      reasoning: 'VE Day occurred on 8 May 1945.',
    }));

    const detHit = await normalizeNaturalDate('May 1945', mock);
    expect(detHit.source).toBe('deterministic');
    expect(detHit.aiGenerated).toBe(false);

    const aiHit = await normalizeNaturalDate('the day WWII ended in Europe', mock);
    expect(aiHit.source).toBe('ai');
    expect(aiHit.aiGenerated).toBe(true);
    expect(aiHit.date?.start).toBe('1945-05-08');
    expect(aiHit.date?.displayOverride).toBe('VE Day');
  });
});
