import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { API_PORT } from './playwright.config.js';

const API = `http://127.0.0.1:${String(API_PORT)}`;
const PASSWORD = 'correct horse battery staple';

let counter = 0;
const uniqueEmail = () => `ai-e2e-${String(Date.now())}-${String(++counter)}@example.com`;

async function useServer(context: BrowserContext): Promise<void> {
  await context.route('**/config.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apiUrl: API }) }),
  );
}

async function signUp(page: Page, email = uniqueEmail()): Promise<void> {
  await page.getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create an account' }).click();
  await dialog.getByLabel('Name').fill('AI E2E Author');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog).toBeHidden();
}

async function expectNoSeriousAxeViolations(page: Page, scope?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (scope) builder = builder.include(scope);
  const results = await builder.analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${JSON.stringify(n.target)} ${n.failureSummary ?? ''}`),
    );
  expect(serious).toEqual([]);
}

test.beforeEach(async ({ context, page }) => {
  await useServer(context);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('natural-language date parser updates start and end dates accessibly', async ({ page }) => {
  const dateGroup = page.getByRole('group', { name: 'Date', exact: true });
  await dateGroup.getByRole('button', { name: 'Parse text' }).click();
  await dateGroup.getByLabel(/Natural language date/i).fill("the summer of '69");
  await expect(dateGroup.getByText(/1969-06 → 1969-08/)).toBeVisible();
  await dateGroup.getByRole('button', { name: 'Apply' }).click();
  await expect(dateGroup.getByLabel('Date year', { exact: true })).toHaveValue('1969');

  const endGroup = page.getByRole('group', { name: 'End date', exact: true });
  await endGroup.getByRole('button', { name: 'Parse text' }).click();
  await endGroup.getByLabel(/Natural language date/i).fill('1970s');
  await endGroup.getByRole('button', { name: 'Apply' }).click();
  await expect(endGroup.getByLabel('End date year', { exact: true })).toHaveValue('1979');

  await expectNoSeriousAxeViolations(page, '#inspector');
});

test('conflict check dialog runs AI check, flags stale results on edits, and passes axe', async ({
  context,
  page,
}) => {
  await context.route('**/api/v1/ai/detect-conflicts', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        aiGenerated: true,
        usage: { inputTokens: 40, outputTokens: 20, totalTokens: 60, estimatedCostMicros: 50 },
        conflicts: [
          {
            id: 'ai-conflict:1',
            kind: 'semantic_contradiction',
            severity: 'warning',
            eventIds: ['apollo-11'],
            message: 'Mission year check flagged potential contradiction.',
            suggestion: 'Double-check mission notes.',
            aiGenerated: true,
          },
        ],
      }),
    }),
  );

  await signUp(page);
  await page.getByRole('button', { name: /Check conflicts|conflict/i }).click();
  const dialog = page.getByRole('dialog', { name: 'Timeline conflict check' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Check with AI' }).click();
  await expect(
    dialog.getByText('Mission year check flagged potential contradiction.'),
  ).toBeVisible();
  await expect(dialog.getByText('AI-flagged')).toBeVisible();
  await expectNoSeriousAxeViolations(page, '[role="dialog"]');

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // Edit timeline, reopen dialog -> AI results stay visible with stale banner
  await page.getByRole('form').getByLabel('Title', { exact: true }).fill('Apollo 11 Updated');
  await page.getByRole('button', { name: /Check conflicts|conflict/i }).click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText(/Timeline changed — previous AI results may be stale/i),
  ).toBeVisible();
  await expect(
    dialog.getByText('Mission year check flagged potential contradiction.'),
  ).toBeVisible();
});

test('AI document extract review requires opt-in, shows citations & passes axe', async ({
  context,
  page,
}) => {
  await context.route('**/api/v1/ai/extract', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        documentTitle: 'Space Race Notes',
        sourceText: 'Sputnik 1 launched on October 4, 1957 from Baikonur.',
        droppedEvents: 0,
        totalChunks: 1,
        processedChunks: 1,
        truncated: false,
        provider: 'mock',
        model: 'mock-model',
        aiGenerated: true,
        usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120, estimatedCostMicros: 30 },
        events: [
          {
            id: 'ai-cand-1',
            title: 'Sputnik 1 Launch',
            date: { start: '1957-10-04' },
            body: 'First orbital satellite launch.',
            tags: ['space'],
            location: { lat: 45.9646, lng: 63.3052, label: 'Baikonur Cosmodrome' },
            citation: {
              quote: 'Sputnik 1 launched on October 4, 1957',
              startOffset: 0,
              endOffset: 37,
            },
            confidence: 0.94,
            aiGenerated: true,
          },
          {
            id: 'ai-cand-2',
            title: 'Unmatched Quote Event',
            date: { start: '1958-01-31' },
            tags: [],
            citation: { quote: 'Not present in document' },
            confidence: 0.65,
            aiGenerated: true,
          },
        ],
      }),
    }),
  );

  await signUp(page);
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import events' });
  await dialog.getByRole('tab', { name: 'AI Document Extract' }).click();

  await dialog
    .getByLabel('Source text')
    .fill('Sputnik 1 launched on October 4, 1957 from Baikonur.');
  await dialog.getByRole('button', { name: 'Extract events' }).click();

  await expect(dialog.getByText('0 of 2 selected for import')).toBeVisible();
  await expect(dialog.getByText('Citation quote not matched verbatim in source')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Add 0 approved events' })).toBeDisabled();

  await dialog.getByRole('button', { name: 'Show in source' }).first().click();
  await expect(dialog.locator('mark')).toHaveText('Sputnik 1 launched on October 4, 1957');
  await expectNoSeriousAxeViolations(page, '[role="dialog"]');

  await dialog.getByLabel('Approve').first().check();
  await dialog.getByLabel(/Include suggested location/i).check();
  await dialog.getByRole('button', { name: 'Add 1 approved event' }).click();

  await expect(dialog).toBeHidden();
  await expect(page.locator('chronicle-timeline .chronicle-event__title').first()).toHaveText(
    'Sputnik 1 Launch',
  );
});
