import { describe, it, expect } from 'vitest';
import { normalizeNaturalDate, normalizeNaturalDateDeterministic } from '../date-normalizer.js';
import { AiProviderError, MockAiProvider } from '../providers.js';

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

  it('preserves approximate flag for "around" and "about" qualifiers', () => {
    const around = normalizeNaturalDateDeterministic('around 1969');
    expect(around.date).toEqual({ start: '1969', approximate: true });

    const about = normalizeNaturalDateDeterministic('about 1850');
    expect(about.date).toEqual({ start: '1850', approximate: true });
  });

  it('rejects month-and-day without a year and invalid calendar dates', () => {
    expect(normalizeNaturalDateDeterministic('May 5').date).toBeNull();
    expect(normalizeNaturalDateDeterministic('July 4').date).toBeNull();
    expect(normalizeNaturalDateDeterministic('1969-13-45').date).toBeNull();
    expect(normalizeNaturalDateDeterministic('February 31, 1969').date).toBeNull();
    expect(normalizeNaturalDateDeterministic('February 29, 2023').date).toBeNull();
    expect(normalizeNaturalDateDeterministic('February 29, 2024').date?.start).toBe('2024-02-29');
  });

  it('treats a bare one- or two-digit number as ambiguous but accepts explicit forms', () => {
    for (const ambiguous of ['20', '5', 'around 20']) {
      const res = normalizeNaturalDateDeterministic(ambiguous);
      expect(res.date).toBeNull();
      expect(res.reasoning).toMatch(/ambiguous/);
    }
    expect(normalizeNaturalDateDeterministic('20 CE').date?.start).toBe('0020');
    expect(normalizeNaturalDateDeterministic('0020').date?.start).toBe('0020');
    expect(normalizeNaturalDateDeterministic('-44').date?.start).toBe('-0044');
    expect(normalizeNaturalDateDeterministic('476').date?.start).toBe('0476');
  });

  it('parses English month dates', () => {
    const res = normalizeNaturalDateDeterministic('July 20, 1969');
    expect(res.date?.start).toBe('1969-07-20');
    expect(res.confidence).toBeGreaterThan(0.9);
  });

  it('falls back to LLM only when deterministic parsing cannot resolve and validates returned dates', async () => {
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

    const invalidAi = new MockAiProvider(() => ({
      start: '2023-02-29',
      confidence: 0.9,
      reasoning: 'Bad leap date',
    }));
    await expect(normalizeNaturalDate('some vague event', invalidAi)).rejects.toThrow(
      AiProviderError,
    );
  });
});
