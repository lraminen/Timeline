import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  CHRONICLE_URL,
  createAccount,
  createProject,
  events,
  timeline,
  type Account,
  type Project,
} from './chronicle.js';

/* The WordPress editor's globals, as far as these tests use them. */
interface WpGlobal {
  data: {
    select: (store: string) => Record<string, (...args: unknown[]) => unknown>;
    dispatch: (store: string) => Record<string, (...args: unknown[]) => unknown>;
  };
  blocks: { createBlock: (name: string, attributes?: object) => unknown };
  apiFetch: (options: { path: string; method?: string; data?: unknown }) => Promise<unknown>;
}
declare global {
  interface Window {
    wp: WpGlobal;
  }
}

test.describe.configure({ mode: 'serial' });

let account: Account;
let spaceRace: Project;
let privateProject: Project;
let syncTarget: Project;

test.beforeAll(async () => {
  account = await createAccount();
  spaceRace = await createProject(
    account,
    timeline('Space Race', [
      {
        title: 'Sputnik 1',
        start: '1957-10-04',
        tags: ['satellite'],
        body: 'First **artificial** satellite.',
      },
      { title: 'Vostok 1', start: '1961-04-12', tags: ['crewed'] },
      { title: 'Apollo 11', start: '1969-07-20', tags: ['crewed', 'moon'] },
    ]),
    { publish: true, isPublic: true },
  );
  privateProject = await createProject(
    account,
    timeline('Secret plans', [{ title: 'Plan', start: '2000' }]),
    {
      publish: true,
      isPublic: false,
    },
  );
  syncTarget = await createProject(account, timeline('From the blog', []), {
    publish: false,
    isPublic: false,
  });
});

async function login(page: Page) {
  await page.goto('/wp-login.php');
  if (await page.locator('#user_login').isVisible()) {
    await page.locator('#user_login').fill('admin');
    await page.locator('#user_pass').fill('password');
    await page.locator('#wp-submit').click();
    await page.waitForURL(/wp-admin/);
  }
}

async function newPost(page: Page) {
  await page.goto('/wp-admin/post-new.php');
  await page.waitForFunction(() =>
    // `wp` and the editor store only exist once the editor has loaded.
    Boolean(
      (window as { wp?: Partial<WpGlobal> }).wp?.data?.select('core/editor').getCurrentPostId?.(),
    ),
  );
  await page.evaluate(() => {
    window.wp.data.dispatch('core/preferences').set?.('core/edit-post', 'welcomeGuide', false);
  });
  const guide = page.getByRole('dialog', { name: /welcome/i });
  if (await guide.isVisible()) await guide.getByRole('button', { name: 'Close' }).click();
  return page.frameLocator('iframe[name="editor-canvas"]');
}

async function insertTimelineBlock(page: Page, attributes: object = {}) {
  await page.evaluate((attrs) => {
    window.wp.data
      .dispatch('core/block-editor')
      .insertBlocks?.(window.wp.blocks.createBlock('chronicle/timeline', attrs));
  }, attributes);
}

async function publish(page: Page, title: string): Promise<string> {
  return page.evaluate(async (postTitle) => {
    const editor = window.wp.data.dispatch('core/editor');
    editor.editPost?.({ title: postTitle, status: 'publish' });
    await editor.savePost?.();
    return window.wp.data.select('core/editor').getPermalink?.() as string;
  }, title);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text());
  });
  return errors;
}

test('connects a Chronicle account on the settings page', async ({ page }) => {
  await login(page);
  await page.goto('/wp-admin/options-general.php?page=chronicle-timeline');
  await expect(page.locator('#chronicle-status')).toContainText('Not connected');

  await page.getByLabel('Chronicle server').fill(CHRONICLE_URL);
  await page.getByLabel('API key').fill('not-a-key');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('That does not look like a Chronicle API key')).toBeVisible();

  await page.getByLabel('API key').fill(account.apiKey);
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.locator('#chronicle-status')).toContainText('Connected as WordPress Tester');
  // The key is never sent back to the browser, only its public prefix.
  await expect(page.getByLabel('API key')).toHaveValue('');
  const secret = account.apiKey.slice('chr_'.length + 13);
  expect(await page.content()).not.toContain(secret);
  await expect(page.getByText(`${account.apiKey.slice(0, 16)}_••••••••`)).toBeVisible();
});

test('embeds a timeline from the account with a live preview, and publishes it', async ({
  page,
  browser,
}) => {
  await login(page);
  const canvas = await newPost(page);
  await insertTimelineBlock(page);

  // The picker lists the account's timelines; private ones can't be chosen.
  const picker = canvas.getByLabel('Your timelines');
  await expect(picker.locator('option', { hasText: 'Secret plans (private)' })).toBeDisabled();
  await expect(
    picker.locator('option', { hasText: 'From the blog (not published yet)' }),
  ).toBeDisabled();
  await picker.selectOption({ label: 'Space Race' });
  await canvas.getByRole('button', { name: 'Embed', exact: true }).click();

  // Live preview: the real web component, upgraded inside the editor iframe.
  const preview = canvas.locator('chronicle-timeline');
  await expect(preview.locator('.chronicle-event')).toHaveCount(3);
  await expect(preview.locator('.chronicle-event__title').first()).toHaveText('Sputnik 1');

  // Display options in the sidebar update the preview.
  await page.getByRole('combobox', { name: 'Layout' }).selectOption('horizontal');
  await expect(preview).toHaveAttribute('layout', 'horizontal');
  await page.getByRole('combobox', { name: 'Only show events tagged' }).fill('crewed');
  await page.keyboard.press('Enter');
  await expect(preview).toHaveAttribute('filter-tags', 'crewed');
  await expect(preview.locator('.chronicle-event')).toHaveCount(2);

  const permalink = await publish(page, 'Our space history');
  expect(permalink).toMatch(/[?&]p=\d+/);

  // Front end: the component upgrades and shows the filtered timeline.
  const frontContext = await browser.newContext();
  const front = await frontContext.newPage();
  const errors = trackErrors(front);
  await front.goto(permalink);
  await expect(front.locator('body.single-post')).toBeVisible();
  await expect(front.getByRole('heading', { level: 1, name: 'Our space history' })).toBeVisible();
  const element = front.locator('.wp-block-chronicle-timeline chronicle-timeline');
  await expect(element).toHaveAttribute('layout', 'horizontal');
  await expect(element.locator('.chronicle-event')).toHaveCount(2);
  // The server-rendered list stays in the light DOM, unrendered once upgraded.
  await expect(front.locator('.ssr-events')).toBeHidden();
  const axe = await new AxeBuilder({ page: front })
    .include('.wp-block-chronicle-timeline')
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  expect(errors).toEqual([]);
  await frontContext.close();

  // Without JavaScript the same page shows the event list and a link.
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const plain = await noJs.newPage();
  await plain.goto(permalink);
  await expect(plain.getByRole('heading', { name: 'Apollo 11' })).toBeVisible();
  await expect(plain.locator('.ssr-body strong')).toHaveText('artificial');
  await expect(plain.getByRole('link', { name: 'View the full timeline' })).toHaveAttribute(
    'href',
    `${CHRONICLE_URL}/timeline/${spaceRace.slug}`,
  );
  await noJs.close();
});

test('embeds a pasted link pinned to a version, and explains bad links', async ({ page }) => {
  await login(page);
  const canvas = await newPost(page);
  await insertTimelineBlock(page);

  const link = canvas.getByLabel('Timeline link or slug');
  await link.fill(`${CHRONICLE_URL}/timeline/${privateProject.slug}?token=abc.def`);
  await canvas.getByRole('button', { name: 'Embed link' }).click();
  await expect(canvas.getByText('This is a private share link')).toBeVisible();

  await link.fill('https://example.org/blog/post');
  await canvas.getByRole('button', { name: 'Embed link' }).click();
  await expect(canvas.getByText('That is not a Chronicle timeline link')).toBeVisible();

  await link.fill(`${CHRONICLE_URL}/timeline/${spaceRace.slug}/v/1`);
  await canvas.getByRole('button', { name: 'Embed link' }).click();
  await expect(canvas.locator('chronicle-timeline .chronicle-event')).toHaveCount(3);
  await expect(page.getByRole('checkbox', { name: 'Pinned to version 1' })).toBeChecked();
  const attributes = await page.evaluate(
    () =>
      (window.wp.data.select('core/block-editor').getBlocks?.() as { attributes: object }[])[0]
        ?.attributes,
  );
  // Links to the configured server are stored without the server, as a slug.
  expect(attributes).toMatchObject({ slug: spaceRace.slug, server: '', version: 1 });

  // A private timeline can't be previewed (its embed is not public).
  await page.getByRole('button', { name: 'Replace' }).click();
  await canvas.getByLabel('Timeline link or slug').fill(privateProject.slug);
  await canvas.getByRole('button', { name: 'Embed link' }).click();
  await expect(canvas.getByText(/This timeline cannot be shown/)).toBeVisible();
});

test('renders the [chronicle] shortcode', async ({ page }) => {
  await login(page);
  await newPost(page);
  const link = (await page.evaluate(
    (slug) =>
      window.wp.apiFetch({
        path: '/wp/v2/posts',
        method: 'POST',
        data: {
          title: 'Shortcode post',
          status: 'publish',
          content: `[chronicle id="${slug}" layout="card" theme="dark" height="500"]`,
        },
      }),
    spaceRace.slug,
  )) as { link: string };
  await page.goto(link.link);
  await expect(page.locator('body.single-post')).toBeVisible();
  const element = page.locator('chronicle-timeline');
  await expect(element).toHaveAttribute('layout', 'card');
  await expect(element).toHaveAttribute('theme', 'dark');
  await expect(element.locator('.chronicle-event')).toHaveCount(3);
  expect(await element.evaluate((el) => (el as HTMLElement).style.height)).toBe('500px');
});

test('syncs published posts into a timeline and removes trashed ones', async ({ page }) => {
  await login(page);
  await page.goto('/wp-admin/options-general.php?page=chronicle-timeline');
  await page.getByLabel('Keep a timeline in sync with published posts').check();
  await page
    .getByRole('combobox', { name: 'Timeline', exact: true })
    .selectOption({ label: 'From the blog' });
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByLabel('Keep a timeline in sync with published posts')).toBeChecked();

  await newPost(page);
  const post = (await page.evaluate(() =>
    window.wp.apiFetch({
      path: '/wp/v2/posts',
      method: 'POST',
      data: {
        title: 'Launch day',
        status: 'publish',
        excerpt: 'We *finally* launched.',
        content: '<p>Body</p>',
        date: '2026-03-14T09:00:00',
      },
    }),
  )) as { id: number; link: string };

  await expect
    .poll(async () => (await events(account, syncTarget.id)).map((e) => e.title))
    .toEqual(['Launch day']);
  const [event] = await events(account, syncTarget.id);
  expect(event?.body).toBe(`We \\*finally\\* launched\\.\n\n[Read more](${post.link})`);

  await page.goto('/wp-admin/options-general.php?page=chronicle-timeline');
  await expect(page.locator('#chronicle-last-sync')).toContainText('Synced.');

  await page.goto('/wp-admin/post-new.php');
  await page.waitForFunction(() => Boolean((window as { wp?: Partial<WpGlobal> }).wp?.apiFetch));
  await page.evaluate(
    (id) => window.wp.apiFetch({ path: `/wp/v2/posts/${String(id)}`, method: 'DELETE' }),
    post.id,
  );
  await expect.poll(async () => (await events(account, syncTarget.id)).length).toBe(0);
});
