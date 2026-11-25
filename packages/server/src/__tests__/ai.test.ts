import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { AiProviderError, MockAiProvider, OpenAiProvider } from '@chronicle/ai';
import { aiUsage, auditLog } from '../db/schema.js';
import {
  createProject,
  createTestServer,
  sampleTimeline,
  signUp,
  type TestContext,
  type TestUser,
} from '../test/harness.js';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

let t: TestContext;
let owner: TestUser;
let stranger: TestUser;
let viewer: TestUser;

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
  () => ({
    altText: 'Astronaut standing on the lunar surface beside the lunar module.',
    confidence: 0.94,
  }),
);

beforeAll(async () => {
  t = await createTestServer(
    { AI_DAILY_REQUEST_LIMIT: '20', AI_DAILY_TOKEN_LIMIT: '50000' },
    { aiProvider: mockAi },
  );
  [owner, stranger, viewer] = await Promise.all([
    signUp(t.app, 'Owner'),
    signUp(t.app, 'Stranger'),
    signUp(t.app, 'Viewer'),
  ]);
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
    const body = status.json<{
      configured: boolean;
      provider: string;
      supportsVision: boolean;
      limits: { maxConcurrent: number };
    }>();
    expect(body.configured).toBe(true);
    expect(body.provider).toBe('mock');
    expect(body.supportsVision).toBe(true);
    expect(body.limits.maxConcurrent).toBe(2);
  });

  it('extracts events from JSON text and multipart files with sourceText, citations & usage tracking', async () => {
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
      sourceText: string;
      events: {
        title: string;
        citation: { quote: string; startOffset?: number };
        aiGenerated: boolean;
      }[];
      usage: { totalTokens: number };
    }>();
    expect(body.aiGenerated).toBe(true);
    expect(body.sourceText).toBe('Apollo 11 landed on July 20, 1969.');
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.aiGenerated).toBe(true);
    expect(body.events[0]?.citation.quote).toBe('Apollo 11 landed on July 20, 1969.');
    expect(body.events[0]?.citation.startOffset).toBe(0);
    expect(body.usage.totalTokens).toBeGreaterThan(0);

    // URL extraction disabled by default
    const urlDisabled = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/extract',
      headers: owner.auth,
      payload: { url: 'https://example.com/article' },
    });
    expect(urlDisabled.statusCode).toBe(400);

    // Usage row & audit entry recorded with status='completed'
    const usageRows = await t.database.db
      .select()
      .from(aiUsage)
      .where(eq(aiUsage.userId, owner.id));
    expect(usageRows.length).toBeGreaterThanOrEqual(1);
    expect(usageRows[0]?.status).toBe('completed');

    const audits = await t.database.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.projectId, project.id));
    expect(audits.some((a) => a.action === 'ai.extract')).toBe(true);
  });

  it('enforces projectId role checks across all AI routes (non-member 404, viewer 403/200)', async () => {
    const project = await createProject(t.app, owner);
    const addViewer = await t.app.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/collaborators`,
      headers: owner.auth,
      payload: { email: viewer.email, role: 'viewer' },
    });
    expect(addViewer.statusCode).toBe(201);

    const targets = [
      { url: '/api/v1/ai/extract', payload: { projectId: project.id, text: 'Secret' } },
      { url: '/api/v1/ai/summarize', payload: { projectId: project.id, title: 'T', body: 'Body' } },
      {
        url: '/api/v1/ai/alt-text',
        payload: {
          projectId: project.id,
          imageDataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
        },
      },
      { url: '/api/v1/ai/normalize-date', payload: { projectId: project.id, text: '1969' } },
      {
        url: '/api/v1/ai/detect-conflicts',
        payload: { projectId: project.id, timeline: sampleTimeline(), includeSemantic: false },
      },
    ];

    for (const req of targets) {
      const sRes = await t.app.inject({
        method: 'POST',
        url: req.url,
        headers: stranger.auth,
        payload: req.payload,
      });
      expect(sRes.statusCode).toBe(404);
    }

    // Viewer cannot invoke write-side AI tools, but can inspect conflicts
    const vSum = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/summarize',
      headers: viewer.auth,
      payload: { projectId: project.id, title: 'T', body: 'Body' },
    });
    expect(vSum.statusCode).toBe(403);

    const vConf = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/detect-conflicts',
      headers: viewer.auth,
      payload: { projectId: project.id, timeline: sampleTimeline(), includeSemantic: false },
    });
    expect(vConf.statusCode).toBe(200);
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
    const body = res.json<{ events: unknown[]; sourceText: string }>();
    expect(body.events).toHaveLength(1);
    expect(body.sourceText).toContain('Apollo 11 landed on July 20, 1969.');
  });

  it('reserves quota before parsing uploads, so parse failures count and an exhausted quota skips parsing', async () => {
    const quotaServer = await createTestServer(
      { AI_DAILY_REQUEST_LIMIT: '1' },
      { aiProvider: mockAi },
    );
    try {
      const u = await signUp(quotaServer.app, 'ParseQuotaUser');
      const boundary = '----chronicle-boundary-pdf';
      const upload = () =>
        quotaServer.app.inject({
          method: 'POST',
          url: '/api/v1/ai/extract',
          headers: { ...u.auth, 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: [
            `--${boundary}`,
            'Content-Disposition: form-data; name="file"; filename="broken.pdf"',
            'Content-Type: application/pdf',
            '',
            '%PDF-1.4 this is not a real PDF',
            `--${boundary}--`,
            '',
          ].join('\r\n'),
        });

      // The parse failure is reported to the client and settled as a failed request.
      const first = await upload();
      expect(first.statusCode).toBe(400);
      const rows = await quotaServer.database.db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.userId, u.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('failed');

      // With the quota used up, the upload is refused before it reaches the parser.
      const second = await upload();
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('ai_quota_exceeded');
    } finally {
      await quotaServer.close();
    }
  });

  it('suggests event summary and validates alt-text bytes across data URLs, local storage & allowlisted hosts', async () => {
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

    // Valid PNG data URL
    const altRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/alt-text',
      headers: owner.auth,
      payload: {
        imageDataUrl: `data:image/png;base64,${TINY_PNG_BASE64}`,
        eventTitle: 'Apollo 11',
      },
    });
    expect(altRes.statusCode).toBe(200);
    expect(altRes.json<{ aiGenerated: boolean; altText: string }>().aiGenerated).toBe(true);

    // Spoofed data URL (claims image/png, actually HTML)
    const spoofed = Buffer.from('<html><script>alert(1)</script></html>', 'utf8').toString(
      'base64',
    );
    const spoofRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/alt-text',
      headers: owner.auth,
      payload: { imageDataUrl: `data:image/png;base64,${spoofed}` },
    });
    expect(spoofRes.statusCode).toBe(400);

    // Local /media/... storage lookup
    const pngBytes = Buffer.from(TINY_PNG_BASE64, 'base64');
    await t.app.ctx.storage.put('projects/test/photo.png', pngBytes, 'image/png');
    const localRes = await t.app.inject({
      method: 'POST',
      url: '/api/v1/ai/alt-text',
      headers: owner.auth,
      payload: { imageUrl: '/media/projects/test/photo.png' },
    });
    expect(localRes.statusCode).toBe(200);

    // Allowlisted https:// image fetch with mocked fetch
    const remoteMockServer = await createTestServer(
      {},
      {
        aiProvider: mockAi,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array(pngBytes));
                  controller.close();
                },
              }),
              {
                status: 200,
                headers: { 'content-type': 'image/png' },
              },
            ),
          ),
      },
    );
    try {
      const u = await signUp(remoteMockServer.app, 'AltUrlUser');
      const allowRes = await remoteMockServer.app.inject({
        method: 'POST',
        url: '/api/v1/ai/alt-text',
        headers: u.auth,
        payload: { imageUrl: 'https://images.unsplash.com/photo-123.png' },
      });
      expect(allowRes.statusCode).toBe(200);
    } finally {
      await remoteMockServer.close();
    }
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
    expect(
      conflicts
        .json<{ conflicts: { kind: string }[] }>()
        .conflicts.some((c) => c.kind === 'semantic_contradiction'),
    ).toBe(true);
  });

  it('enforces daily request & token quotas, concurrency caps, mid-extraction failure settlement, and 502 redaction', async () => {
    // 1. Unconfigured -> 503
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

    // 2. Token limit enforcement
    const tokenCapped = await createTestServer(
      { AI_DAILY_REQUEST_LIMIT: '50', AI_DAILY_TOKEN_LIMIT: '100' },
      { aiProvider: mockAi },
    );
    try {
      const u = await signUp(tokenCapped.app, 'TokenUser');
      const first = await tokenCapped.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'One', body: 'Long text '.repeat(40) },
      });
      expect(first.statusCode).toBe(200);
      const second = await tokenCapped.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'Two', body: 'Another summary body' },
      });
      expect(second.statusCode).toBe(429);
      expect(second.json<{ error: { code: string } }>().error.code).toBe('ai_quota_exceeded');
    } finally {
      await tokenCapped.close();
    }

    // 3. Mid-extraction failure settles partial tokens & count against quota
    let chunkCalls = 0;
    const flakyAi = new MockAiProvider((req) => {
      chunkCalls += 1;
      if (chunkCalls === 2 && req.schemaName === 'ExtractedEvents') {
        throw new AiProviderError(
          'openai',
          502,
          'AI provider request failed',
          'chunk 2 secret-key-123',
        );
      }
      return {
        events: [
          {
            title: 'Sputnik 1',
            date: { start: '1957-10-04' },
            citation: { quote: 'Sputnik 1 launched.' },
            confidence: 0.9,
          },
        ],
      };
    });
    const flakyServer = await createTestServer(
      { AI_DAILY_REQUEST_LIMIT: '1', AI_DAILY_TOKEN_LIMIT: '50000' },
      { aiProvider: flakyAi },
    );
    try {
      const u = await signUp(flakyServer.app, 'FlakyUser');
      const text = 'Sputnik 1 launched. ' + 'x '.repeat(3500) + '\n\nMore text in chunk two.';
      const failRes = await flakyServer.app.inject({
        method: 'POST',
        url: '/api/v1/ai/extract',
        headers: u.auth,
        payload: { text },
      });
      expect(failRes.statusCode).toBe(502);
      expect(failRes.json<{ error: { message: string } }>().error.message).toBe(
        'AI provider request failed',
      );
      expect(JSON.stringify(failRes.json())).not.toContain('secret-key-123');

      // Settled failed row recorded partial chunk 1 tokens and consumed the 1 daily request quota
      const rows = await flakyServer.database.db
        .select()
        .from(aiUsage)
        .where(eq(aiUsage.userId, u.id));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('failed');
      expect((rows[0]?.inputTokens ?? 0) + (rows[0]?.outputTokens ?? 0)).toBeGreaterThan(0);

      const nextRes = await flakyServer.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'After fail', body: 'Body' },
      });
      expect(nextRes.statusCode).toBe(429);
    } finally {
      await flakyServer.close();
    }

    // 4. Parallel burst atomically blocked by concurrency/quota reservation
    let releaseSlow!: () => void;
    const gate = new Promise<void>((r) => {
      releaseSlow = r;
    });
    const slowAi = new MockAiProvider(async () => {
      await gate;
      return { summary: 'Done' };
    });
    const concurrentServer = await createTestServer(
      { AI_MAX_CONCURRENT_PER_USER: '1', AI_DAILY_REQUEST_LIMIT: '10' },
      { aiProvider: slowAi },
    );
    try {
      const u = await signUp(concurrentServer.app, 'BurstUser');
      const p1 = concurrentServer.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'Burst 1', body: 'Body 1' },
      });
      // Allow p1 to reach reservation and wait on gate before firing p2
      await new Promise((r) => setTimeout(r, 30));
      const p2 = await concurrentServer.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'Burst 2', body: 'Body 2' },
      });
      expect(p2.statusCode).toBe(429);
      expect(p2.json<{ error: { code: string } }>().error.code).toBe('ai_concurrent_limit');
      releaseSlow();
      const r1 = await p1;
      expect(r1.statusCode).toBe(200);
    } finally {
      await concurrentServer.close();
    }

    // 5. Upstream HTTP error redaction through real OpenAiProvider
    const realErrProvider = new OpenAiProvider('sk-real-secret', {
      fetch: () =>
        Promise.resolve(
          new Response('Upstream key sk-real-secret rejected by org-123', { status: 401 }),
        ),
    });
    const errServer = await createTestServer({}, { aiProvider: realErrProvider });
    try {
      const u = await signUp(errServer.app, 'ErrUser');
      const res = await errServer.app.inject({
        method: 'POST',
        url: '/api/v1/ai/summarize',
        headers: u.auth,
        payload: { title: 'Test', body: 'Body text' },
      });
      expect(res.statusCode).toBe(502);
      const bodyStr = JSON.stringify(res.json());
      expect(bodyStr).toContain('AI provider request failed');
      expect(bodyStr).not.toContain('sk-real-secret');
      expect(bodyStr).not.toContain('org-123');
    } finally {
      await errServer.close();
    }
  });
});
