import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { API_PORT } from './playwright.config.js';

const API = `http://127.0.0.1:${String(API_PORT)}`;
const PASSWORD = 'correct horse battery staple';

/** Points the editor at the test server via its runtime config. */
async function useServer(context: BrowserContext): Promise<void> {
  await context.route('**/config.json', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ apiUrl: API }) }),
  );
}

let counter = 0;
const uniqueEmail = () => `e2e-${String(Date.now())}-${String(++counter)}@example.com`;

const syncStatus = (page: Page) => page.locator('[data-sync]');
const titleInput = (page: Page) => page.getByRole('form').getByLabel('Title', { exact: true });

/** The timeline's own title (Timeline tab) — what projects and pages are named by. */
async function timelineTitle(page: Page) {
  await page.getByRole('tab', { name: 'Timeline' }).click();
  return page.getByRole('tabpanel', { name: 'Timeline' }).getByLabel('Title', { exact: true });
}

async function signUp(page: Page, email = uniqueEmail()): Promise<string> {
  await page.getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create an account' }).click();
  await dialog.getByLabel('Name').fill('E2E Author');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Create account' }).click();
  await expect(dialog).toBeHidden();
  return email;
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.getByRole('button', { name: 'Sign in' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Password').fill(PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in' }).click();
  await expect(dialog).toBeHidden();
}

async function saveToServer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Save to Chronicle' }).click();
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'synced');
}

async function openFromServer(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Open from Chronicle…' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: new RegExp(title) })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
}

test.beforeEach(async ({ context, page }) => {
  await useServer(context);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
});

test('signs up, saves to the server, syncs edits and survives a reload', async ({ page }) => {
  await signUp(page);
  await saveToServer(page);

  await titleInput(page).fill('Edited and synced');
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'synced');

  // Session (refresh cookie) and link (IndexedDB) both survive a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: /^Account:/ })).toBeVisible();
  await expect(titleInput(page)).toHaveValue('Edited and synced');
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'synced');
});

test('publishes a public timeline with a server-rendered page', async ({ page, context }) => {
  await signUp(page);
  await (await timelineTitle(page)).fill('Moonshot');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Publish timeline' });
  await expect(dialog).toBeVisible();
  const axe = await new AxeBuilder({ page }).include('[role=dialog]').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );

  await dialog.getByRole('button', { name: 'Publish' }).click();
  const done = page.getByRole('dialog', { name: 'Published version 1' });
  await expect(done).toBeVisible();
  const pageUrl = await done.getByLabel('Page link').inputValue();
  expect(pageUrl).toMatch(new RegExp(`^${API}/timeline/[a-z0-9-]+$`));
  await expect(done.getByLabel('Embed code')).toHaveValue(/\/embed\.js/);

  // The published page: server-rendered, then upgraded to the interactive timeline.
  const published = await context.newPage();
  const errors: string[] = [];
  published.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await published.goto(pageUrl);
  await expect(published.getByRole('heading', { level: 1 })).toHaveText('Moonshot');
  await expect(published.locator('chronicle-timeline .chronicle-event')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('merges live edits from two browsers, with presence and comments', async ({
  page,
  browser,
}) => {
  const email = await signUp(page);
  await (await timelineTitle(page)).fill('Shared timeline');
  await saveToServer(page);

  // A second device opens the same project.
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4174' });
  await useServer(other);
  const second = await other.newPage();
  await second.goto('/');
  await signIn(second, email);
  await openFromServer(second, 'Shared timeline');

  // Each sees the other (same account, another browser).
  await expect(page.locator('[data-connection="live"]')).toHaveAttribute(
    'aria-label',
    'Also here: E2E Author',
  );
  await expect(second.locator('[data-connection="live"]')).toHaveAttribute(
    'aria-label',
    'Also here: E2E Author',
  );

  // Edits made at the same time in both browsers merge — no conflict dialog.
  await titleInput(page).fill('Edited in browser A');
  await (await timelineTitle(second)).fill('Renamed in browser B');
  await expect(titleInput(second)).toHaveValue('Edited in browser A');
  await expect(await timelineTitle(page)).toHaveValue('Renamed in browser B');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'synced');
  await expect(syncStatus(second)).toHaveAttribute('data-sync', 'synced');

  // A comment on the event shows up live in the other browser.
  await page.getByLabel('New comment on this event').fill('Is this date right?');
  await page.getByRole('button', { name: 'Comment', exact: true }).click();
  await expect(second.getByText('Is this date right?')).toBeVisible();
  await second.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.getByRole('button', { name: 'Show 1 resolved' })).toBeVisible();

  const axe = await new AxeBuilder({ page }).include('#inspector').analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );
  await other.close();
});

test('queues edits made offline and syncs them on reconnect', async ({
  page,
  context,
  browser,
}) => {
  const email = await signUp(page);
  await (await timelineTitle(page)).fill('Offline queue');
  await saveToServer(page);

  await context.setOffline(true);
  await (await timelineTitle(page)).fill('Written on a plane');
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'offline');

  await context.setOffline(false);
  await expect(syncStatus(page)).toHaveAttribute('data-sync', 'synced');

  // Verify from a separate browser that the server has the offline edit.
  const other = await browser.newContext({ baseURL: 'http://127.0.0.1:4174' });
  await useServer(other);
  const check = await other.newPage();
  await check.goto('/');
  await signIn(check, email);
  await openFromServer(check, 'Written on a plane');
  await expect(await timelineTitle(check)).toHaveValue('Written on a plane');
  await other.close();
});

test('uploads media through the server pipeline', async ({ page }) => {
  await signUp(page);
  await saveToServer(page);
  const jpeg = readFileSync(new URL('./fixtures/photo.jpg', import.meta.url));
  await page.getByRole('form').locator('input[type=file]').setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: jpeg,
  });
  const urlField = page.getByRole('form').getByLabel('URL');
  await expect(urlField).toHaveValue(new RegExp(`^${API}/media/projects/.+/display\\.webp$`));
  const src = await urlField.inputValue();
  const res = await page.request.get(src);
  expect(res.headers()['content-type']).toBe('image/webp');
  await expect(
    page.locator('chronicle-timeline .chronicle-event__media img').first(),
  ).toHaveAttribute('src', src);
});

test('creates an API key shown once, which works until it is revoked', async ({ page }) => {
  await signUp(page);
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'API keys…' }).click();
  const dialog = page.getByRole('dialog', { name: 'API keys' });
  await expect(dialog.getByText('No keys yet.')).toBeVisible();

  await dialog.getByLabel('New key name').fill('Our WordPress site');
  await dialog.getByRole('button', { name: 'Create key' }).click();
  const field = dialog.getByLabel('New key “Our WordPress site”');
  await expect(field).toHaveValue(/^chr_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
  const key = await field.inputValue();
  expect((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations).toEqual(
    [],
  );

  const me = () => page.request.get(`${API}/api/v1/me`, { headers: { 'x-api-key': key } });
  expect((await me()).status()).toBe(200);

  // Reopening lists the key by prefix only; the secret is gone for good.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'API keys…' }).click();
  await expect(dialog.getByText('Our WordPress site')).toBeVisible();
  await expect(dialog.getByText(`${key.slice(0, 17)}…`)).toBeVisible();
  expect(await dialog.innerText()).not.toContain(key.slice(17));

  page.once('dialog', (confirm) => void confirm.accept());
  await dialog.getByRole('button', { name: 'Revoke Our WordPress site' }).click();
  await expect(dialog.getByText('No keys yet.')).toBeVisible();
  expect((await me()).status()).toBe(401);
});
