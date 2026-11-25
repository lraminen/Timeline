import type { TimelineDate } from '@chronicle/schema';
import { z } from 'zod';
import type { AiProvider, DateNormalizationResult } from './types.js';

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const SEASONS: Record<string, { startMonth: number; endMonth: number; label: string }> = {
  spring: { startMonth: 3, endMonth: 5, label: 'Spring' },
  summer: { startMonth: 6, endMonth: 8, label: 'Summer' },
  autumn: { startMonth: 9, endMonth: 11, label: 'Autumn' },
  fall: { startMonth: 9, endMonth: 11, label: 'Fall' },
  winter: { startMonth: 12, endMonth: 2, label: 'Winter' },
};

function padYear(year: number, bce = false): string {
  return `${bce ? '-' : ''}${String(Math.abs(year)).padStart(4, '0')}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function expandTwoDigitYear(shortYear: number): number {
  // '69 -> 1969, '15 -> 2015 (pivot at 30)
  return shortYear <= 30 ? 2000 + shortYear : 1900 + shortYear;
}

/**
 * Deterministic natural-language date parser for common historical, seasonal,
 * decade, century, and approximate expressions. Works completely offline.
 */
export function normalizeNaturalDateDeterministic(raw: string): DateNormalizationResult {
  const input = raw.trim();
  if (!input) {
    return {
      input: raw,
      date: null,
      confidence: 0,
      reasoning: 'Empty date input.',
      source: 'deterministic',
      aiGenerated: false,
    };
  }

  // Strip outer qualifiers like "in ", "around ", "the "
  let text = input.replace(/^(?:in|on|during|around|about)\s+/i, '').trim();
  text = text.replace(/^the\s+/i, '').trim();

  let approximate = false;
  let uncertain = false;
  if (text.endsWith('?') || /\b(?:possibly|perhaps|uncertain|maybe)\b/i.test(text)) {
    uncertain = true;
    text = text.replace(/\?$/, '').replace(/\b(?:possibly|perhaps|uncertain|maybe)\b/gi, '').trim();
  }
  if (/^(?:c\.|ca\.|circa|~|approx\.?|roughly|around)\s*/i.test(text)) {
    approximate = true;
    text = text.replace(/^(?:c\.|ca\.|circa|~|approx\.?|roughly|around)\s*/i, '').trim();
  }

  // 1. Direct ISO / partial ISO: 1969, 1969-07, 1969-07-20, -0044
  const iso = /^(-?)(\d{1,6})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(text);
  if (iso) {
    const bce = iso[1] === '-';
    const year = Number(iso[2]);
    if (year >= 1) {
      const start = `${padYear(year, bce)}${iso[3] ? `-${iso[3]}` : ''}${iso[4] ? `-${iso[4]}` : ''}`;
      return {
        input: raw,
        date: {
          start,
          ...(approximate ? { approximate: true } : {}),
          ...(uncertain ? { uncertain: true } : {}),
        },
        confidence: 0.99,
        reasoning: 'Parsed ISO / partial-ISO date.',
        source: 'deterministic',
        aiGenerated: false,
      };
    }
  }

  // 2. Era suffix: "44 BC", "500 BCE", "1066 AD"
  const eraOnly = /^(\d{1,6})\s*(B\.?C\.?E?\.?|BCE|BC|C\.?E\.?|CE|A\.?D\.?|AD)$/i.exec(text);
  if (eraOnly?.[1] && eraOnly[2]) {
    const bce = /^b/i.test(eraOnly[2]);
    const year = Number(eraOnly[1]);
    if (year >= 1) {
      return {
        input: raw,
        date: {
          start: padYear(year, bce),
          ...(approximate ? { approximate: true } : {}),
          ...(uncertain ? { uncertain: true } : {}),
        },
        confidence: 0.96,
        reasoning: `Parsed ${bce ? 'BCE' : 'CE'} year.`,
        source: 'deterministic',
        aiGenerated: false,
      };
    }
  }

  // 3. Seasonal expressions: "summer of '69", "Summer 1969", "Winter of 1941"
  const seasonMatch =
    /^(spring|summer|autumn|fall|winter)(?:\s+of)?\s+(?:'(\d{2})|(\d{4}))$/i.exec(text);
  if (seasonMatch?.[1]) {
    const season = SEASONS[seasonMatch[1].toLowerCase()];
    const year = seasonMatch[2]
      ? expandTwoDigitYear(Number(seasonMatch[2]))
      : Number(seasonMatch[3]);
    if (season && year >= 1) {
      const endYear = season.startMonth > season.endMonth ? year + 1 : year;
      const date: TimelineDate = {
        start: `${padYear(year)}-${pad2(season.startMonth)}`,
        end: `${padYear(endYear)}-${pad2(season.endMonth)}`,
        approximate: true,
        ...(uncertain ? { uncertain: true } : {}),
        displayOverride: `${season.label} ${String(year)}`,
      };
      return {
        input: raw,
        date,
        confidence: 0.88,
        reasoning: `Mapped "${seasonMatch[1]}" to seasonal month range.`,
        source: 'deterministic',
        aiGenerated: false,
      };
    }
  }

  // 4. Quarter expressions: "Q1 2024", "Q3 of 1998"
  const quarterMatch = /^Q([1-4])(?:\s+of)?\s+(\d{4})$/i.exec(text);
  if (quarterMatch?.[1] && quarterMatch[2]) {
    const q = Number(quarterMatch[1]);
    const year = Number(quarterMatch[2]);
    const startMonth = (q - 1) * 3 + 1;
    const endMonth = q * 3;
    return {
      input: raw,
      date: {
        start: `${padYear(year)}-${pad2(startMonth)}`,
        end: `${padYear(year)}-${pad2(endMonth)}`,
        ...(approximate ? { approximate: true } : {}),
        ...(uncertain ? { uncertain: true } : {}),
        displayOverride: `Q${String(q)} ${String(year)}`,
      },
      confidence: 0.94,
      reasoning: `Parsed calendar quarter Q${String(q)}.`,
      source: 'deterministic',
      aiGenerated: false,
    };
  }

  // 5. Decades: "1960s", "early 1920s", "late '80s"
  const decadeMatch =
    /^(?:(early|mid|late)[-\s]+)?(?:'(\d)0s|(\d{3})0s)(?:\s*(BCE|BC))?$/i.exec(text);
  if (decadeMatch) {
    const part = decadeMatch[1]?.toLowerCase();
    const bce = Boolean(decadeMatch[4]);
    const decadeStart = decadeMatch[2]
      ? expandTwoDigitYear(Number(decadeMatch[2]) * 10)
      : Number(decadeMatch[3]) * 10;
    let startY = decadeStart;
    let endY = decadeStart + 9;
    if (part === 'early') endY = decadeStart + 3;
    else if (part === 'mid') {
      startY = decadeStart + 3;
      endY = decadeStart + 6;
    } else if (part === 'late') startY = decadeStart + 7;

    if (bce) {
      // BCE counts down chronologically: earlier year is larger magnitude
      const earlier = decadeStart + 9;
      const later = decadeStart;
      return {
        input: raw,
        date: {
          start: padYear(earlier, true),
          end: padYear(later, true),
          approximate: true,
          ...(uncertain ? { uncertain: true } : {}),
          displayOverride: input,
        },
        confidence: 0.85,
        reasoning: 'Parsed BCE decade range.',
        source: 'deterministic',
        aiGenerated: false,
      };
    }

    return {
      input: raw,
      date: {
        start: padYear(startY),
        end: padYear(endY),
        approximate: true,
        ...(uncertain ? { uncertain: true } : {}),
        displayOverride: input,
      },
      confidence: 0.88,
      reasoning: `Parsed ${part ?? 'full'} decade range.`,
      source: 'deterministic',
      aiGenerated: false,
    };
  }

  // 6. Centuries: "early 20th century", "19th century", "5th century BCE"
  const centuryMatch =
    /^(?:(early|mid|late)[-\s]+)?(\d{1,2})(?:st|nd|rd|th)\s+century(?:\s*(BCE|BC|CE|AD))?$/i.exec(
      text,
    );
  if (centuryMatch?.[2]) {
    const part = centuryMatch[1]?.toLowerCase();
    const c = Number(centuryMatch[2]);
    const bce = Boolean(centuryMatch[3] && /^b/i.test(centuryMatch[3]));
    if (c >= 1) {
      if (bce) {
        const earlier = c * 100;
        const later = (c - 1) * 100 + 1;
        return {
          input: raw,
          date: {
            start: padYear(earlier, true),
            end: padYear(later, true),
            approximate: true,
            ...(uncertain ? { uncertain: true } : {}),
            displayOverride: input,
          },
          confidence: 0.84,
          reasoning: `Parsed ${String(c)}th century BCE range.`,
          source: 'deterministic',
          aiGenerated: false,
        };
      }
      const cStart = (c - 1) * 100 + 1;
      const cEnd = c * 100;
      let startY = cStart;
      let endY = cEnd;
      if (part === 'early') endY = cStart + 29;
      else if (part === 'mid') {
        startY = cStart + 30;
        endY = cStart + 69;
      } else if (part === 'late') startY = cStart + 70;

      return {
        input: raw,
        date: {
          start: padYear(startY),
          end: padYear(endY),
          approximate: true,
          ...(uncertain ? { uncertain: true } : {}),
          displayOverride: input,
        },
        confidence: 0.86,
        reasoning: `Parsed ${part ?? 'full'} ${String(c)}th century range.`,
        source: 'deterministic',
        aiGenerated: false,
      };
    }
  }

  // 7. Month-first or day-first English dates: "July 20, 1969", "20 July 1969", "May 1945"
  const monthFirst =
    /^([A-Za-z]+)\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{1,6})(?:\s*(BCE|BC|CE|AD))?$/i.exec(
      text,
    );
  if (monthFirst?.[1] && monthFirst[3]) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    const day = monthFirst[2] ? Number(monthFirst[2]) : undefined;
    const year = Number(monthFirst[3]);
    const bce = Boolean(monthFirst[4] && /^b/i.test(monthFirst[4]));
    if (month && year >= 1 && (!day || (day >= 1 && day <= 31))) {
      return {
        input: raw,
        date: {
          start: `${padYear(year, bce)}-${pad2(month)}${day ? `-${pad2(day)}` : ''}`,
          ...(approximate ? { approximate: true } : {}),
          ...(uncertain ? { uncertain: true } : {}),
        },
        confidence: 0.96,
        reasoning: 'Parsed English month date.',
        source: 'deterministic',
        aiGenerated: false,
      };
    }
  }

  const dayFirst =
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{1,6})(?:\s*(BCE|BC|CE|AD))?$/i.exec(
      text,
    );
  if (dayFirst?.[1] && dayFirst[2] && dayFirst[3]) {
    const day = Number(dayFirst[1]);
    const month = MONTHS[dayFirst[2].toLowerCase()];
    const year = Number(dayFirst[3]);
    const bce = Boolean(dayFirst[4] && /^b/i.test(dayFirst[4]));
    if (month && day >= 1 && day <= 31 && year >= 1) {
      return {
        input: raw,
        date: {
          start: `${padYear(year, bce)}-${pad2(month)}-${pad2(day)}`,
          ...(approximate ? { approximate: true } : {}),
          ...(uncertain ? { uncertain: true } : {}),
        },
        confidence: 0.96,
        reasoning: 'Parsed day-month-year date.',
        source: 'deterministic',
        aiGenerated: false,
      };
    }
  }

  return {
    input: raw,
    date: null,
    confidence: 0,
    reasoning: 'Could not deterministically parse this date expression.',
    source: 'deterministic',
    aiGenerated: false,
  };
}

const LlmDateSchema = z.object({
  start: z.string().min(1),
  end: z.string().optional().nullable(),
  approximate: z.boolean().optional(),
  uncertain: z.boolean().optional(),
  displayOverride: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

/**
 * Normalizes a natural-language date expression into a Chronicle `TimelineDate`.
 * Uses deterministic parsing first, falling back to the LLM provider for complex
 * historical/contextual expressions when provided.
 */
export async function normalizeNaturalDate(
  raw: string,
  provider?: AiProvider,
): Promise<DateNormalizationResult> {
  const deterministic = normalizeNaturalDateDeterministic(raw);
  if (deterministic.date && deterministic.confidence >= 0.8) {
    return deterministic;
  }
  if (!provider) {
    return deterministic;
  }

  const res = await provider.completeStructured({
    schemaName: 'NormalizedDate',
    schema: LlmDateSchema,
    system: [
      'Convert natural-language historical or relative date expressions into Chronicle partial-ISO dates.',
      'Formats: "YYYY", "YYYY-MM", or "YYYY-MM-DD". Use leading "-" with 4+ digits for BCE (e.g. "-0044" for 44 BCE).',
      'Set approximate=true for ranges/seasons/centuries/circa dates, uncertain=true when explicitly uncertain.',
      'Return JSON: { "start": string, "end"?: string|null, "approximate"?: boolean, "uncertain"?: boolean, "displayOverride"?: string|null, "confidence": number, "reasoning": string }.',
    ].join(' '),
    prompt: `Normalize this date expression: ${JSON.stringify(raw)}`,
    maxTokens: 300,
    temperature: 0.1,
  });

  const d = res.data;
  const date: TimelineDate = {
    start: d.start,
    ...(d.end ? { end: d.end } : {}),
    ...(d.approximate ? { approximate: true } : {}),
    ...(d.uncertain ? { uncertain: true } : {}),
    ...(d.displayOverride ? { displayOverride: d.displayOverride } : {}),
  };

  return {
    input: raw,
    date,
    confidence: d.confidence,
    reasoning: d.reasoning,
    source: 'ai',
    aiGenerated: true,
    usage: res.usage,
  };
}
