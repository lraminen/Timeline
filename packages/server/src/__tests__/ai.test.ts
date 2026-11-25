import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MockAiProvider } from '@chronicle/ai';
import { aiUsage, auditLog } from '../db/schema.js';
import { createProject, createTestServer, sampleTimeline, signUp, type TestContext, type TestUser } from '../test/harness.js';

let t: TestContext;
let owner: TestUser;
let stranger: TestUser;

const mockAi = new MockAiProvider(
  (req) => {
    if (req.schemaName === 'ExtractedEvents') {
      return {
        documentTitle: 'Apollo Program Notes',
        events: [
          {
            title: 'Apollo 11 Moon Landing',
            date: { start: '1969-07-20' },
            body: 'First crewed Moon landing.',
            tags: ['space', 'apollo'],
            citation: { quote: 'Apollo 11 landed on July 20, 1969.' },
            confidence: 0.96,
          },
        ],
      };
    }
    if (req.schemaName === 'EventSummary') {
      return { summary: 'Apollo 11 achieved the first crewed lunar landing in July 1969.' };
    }
    if (req.schemaName === 'NormalizedDate') {
      return {
        start: '1945-05-08',
        displayOverride: 'VE Day',
        confidence: 0.92,
        reasoning: 'Victory in Europe Day was May 8, 1945.',
      };
    }
    if (req.schemaName === 'SemanticConflicts') {
      return {
        conflicts: [
          {
            eventIds: ['sputnik', 'apollo'],
            severity: 'warning',
            message: 'Program timeline check flagged potential discrepancy.',
            suggestion: 'Verify dates.',
          },
        ],
      };
    }
    return {};
  },
  () => ({ altText: 'Astronaut standing on the lunar surface beside the lunar module.', confidence: 0.94 }),
);

beforeAll(async () => {
  t = await createTestServer(
    { AI_DAILY_REQUEST_LIMIT: '10', AI_DAILY_TOKEN_LIMIT: '50000' },
    { aiProvider: mockAi },
  );
  [owner, stranger] = await Promise.all([signUp(t.app, 'Owner'), signUp(t.app, 'Stranger')]);
});

afterAll(async () => {
  await t.close();
});

describe('AI routes', () => {
  it('requires authentication and reports status & usage', async () => {
    const unauth = await t.app.inject({ method: 'GET', url: '/api/v1/ai/status' });
    expect(unauth.statusCode).toBe(401);

    const status = await t.app.inject({
      method: 'GET',
      url: '/api/v1/ai/status',
      headers: owner.auth,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json<{ configured: boolean; provider: string; supportsVision: boolean }>();
    expect(body.configured).toBe(true);
    expect(body.provider).toBe('mock');
    expect(body.supportsVision).toBe(true);
  });

  it('extracts events from JSON text and multipart files with citations & usage tracking', async () => {
    const project = await createProject(t.app, owner);

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/extract',
      headers: owner.auth,
      payload: {
        projectId: project.id,
        text: 'Apollo 11 landed on July 20, 1969.',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      aiGenerated: boolean;
      events: { title: string; citation: { quote: string; startOffset?: number }; aiGenerated: boolean }[];
      usage: { totalTokens: number };
    }>();
    expect(body.aiGenerated).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.aiGenerated).toBe(true);
    expect(body.events[0]?.citation.quote).toBe('Apollo 11 landed on July 20, 1969.');
    expect(body.events[0]?.citation.startOffset).toBe(0);
    expect(body.usage.totalTokens).toBeGreaterThan(0);

    // Non-member cannot extract into someone else's project
    const forbiddenRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/extract',
      headers: stranger.auth,
      payload: { projectId: project.id, text: 'Secret' },
    });
    expect(forbiddenRes.statusCode).toBe(404);

    // Usage row & audit entry recorded
    const usageRows = await t.database.db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.userId, owner.id));
    expect(usageRows.length).toBeGreaterThanOrEqual(1);

    const audits = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, project.id));
    expect(audits.some((a) => a.action === 'ai.extract')).toBe(true);
  });

  it('extracts events from multipart uploaded TXT/HTML documents', async () => {
    const boundary = '----chronicle-boundary-123';
    const payload = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="file"; filename="notes.html"',
      'Content-Type: text/html',
      '',
      '<html><body><p>Apollo 11 landed on July 20, 1969.</p></body></html>',
      `--${boundary}--`,
      '',
    ].join('\r\n');

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/extract',
      headers: {
        ...owner.auth,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ events: unknown[] }>().events).toHaveLength(1);
  });

  it('suggests event summary and image alt text marked as aiGenerated', async () => {
    const sumRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/summarize',
      headers: owner.auth,
      payload: {
        title: 'Apollo 11',
        body: 'Long narrative description of the Apollo 11 mission '.repeat(10),
      },
    });
    expect(sumRes.statusCode).toBe(200);
    expect(sumRes.json<{ aiGenerated: boolean; summary: string }>().aiGenerated).toBe(true);

    // Tiny valid 1x1 PNG data URL
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const altRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/alt-text',
      headers: owner.auth,
      payload: {
        imageDataUrl: `data:image/png;base64,${tinyPngBase64}`,
        eventTitle: 'Apollo 11',
      },
    });
    expect(altRes.statusCode).toBe(200);
    expect(altRes.json<{ aiGenerated: boolean; altText: string }>().aiGenerated).toBe(true);
  });

  it('normalizes dates deterministically and with LLM fallback, and detects conflicts', async () => {
    const detDate = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/normalize-date',
      headers: owner.auth,
      payload: { text: "the summer of '69" },
    });
    expect(detDate.statusCode).toBe(200);
    expect(detDate.json<{ source: string; date: { start: string; end: string } }>().source).toBe(
      'deterministic',
    );
    expect(detDate.json<{ date: { start: string; end: string } }>().date.start).toBe('1969-06');

    const aiDate = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/normalize-date',
      headers: owner.auth,
      payload: { text: 'Victory in Europe Day' },
    });
    expect(aiDate.statusCode).toBe(200);
    expect(aiDate.json<{ source: string; aiGenerated: boolean }>().source).toBe('ai');
    expect(aiDate.json<{ aiGenerated: boolean }>().aiGenerated).toBe(true);

    const conflicts = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/detect-conflicts',
      headers: owner.auth,
      payload: { timeline: sampleTimeline(), includeSemantic: true },
    });
    expect(conflicts.statusCode).toBe(200);
    expect(conflicts.json<{ conflicts: { kind: string }[] }>().conflicts.some(
      (c) => c.kind === 'semantic_contradiction',
    )).toBe(true);
  });

  it('enforces daily AI request quotas and returns 503 when unconfigured', async () => {
    const unconfigured = await createTestServer({}, { aiProvider: null });
    try {
      const u = await signUp(unconfigured.app, 'NoAiUser');
      const res = await unconfigured.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'Test', body: 'Body text' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json<{ error: { code: string } }>().error.code).toBe('ai_not_configured');
    } finally {
      await unconfigured.close();
    }

    const capped = await createTestServer(
      { AI_DAILY_REQUEST_LIMIT: '1' },
      { aiProvider: mockAi },
    );
    try {
      const u = await signUp(capped.app, 'QuotaUser');
      const first = await capped.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'One', body: 'First request body' },
      });
      expect(first.statusCode).toBe(200);
      const second = await capped.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'Two', body: 'Second request body' },
      });
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('ai_quota_exceeded');
    } finally {
      await capped.close();
    }
  });
});
