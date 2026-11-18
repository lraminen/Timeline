import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** The preview's shadow DOM is pierced by Playwright's CSS engine. */
const preview = (page: Page) => page.locator('chronicle-timeline');
const previewTitles = (page: Page) => preview(page).locator('.chronicle-event__title');
const listItems = (page: Page) =>
  page.getByRole('list', { name: 'Events', exact: true }).getByRole('listitem');
const titleInput = (page: Page) => page.getByRole('form').getByLabel('Title', { exact: true });

/** Event titles of every draft persisted in IndexedDB (what survives a reload). */
function savedEventTitles(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('chronicle-editor');
        open.onerror = () => {
          reject(open.error ?? new Error('open failed'));
        };
        open.onsuccess = () => {
          const req = open.result.transaction('drafts').objectStore('drafts').getAll();
          req.onsuccess = () => {
            const drafts = req.result as { doc: { events: { title: string }[] } }[];
            resolve(drafts.flatMap((d) => d.doc.events.map((e) => e.title)));
            open.result.close();
          };
        };
      }),
  );
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await expect(previewTitles(page)).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('has no serious accessibility violations', async ({ page }) => {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) =>
      v.nodes.map((n) => `${v.id}: ${JSON.stringify(n.target)} ${n.failureSummary ?? ''}`),
    );
  expect(serious).toEqual([]);
});

test('editing a title updates list and preview, keeps focus, and undoes in one step', async ({
  page,
}) => {
  const input = titleInput(page);
  await input.fill('');
  await input.pressSequentially('Moonwalk', { delay: 20 });
  await expect(input).toBeFocused();
  await expect(listItems(page).first()).toContainText('Moonwalk');
  await expect(previewTitles(page).first()).toHaveText('Moonwalk');

  await page.keyboard.press(`${MOD}+z`);
  await expect(input).toHaveValue('Apollo 11 lands on the Moon');
  await expect(previewTitles(page).first()).toHaveText('Apollo 11 lands on the Moon');
});

test('an invalid edit pauses the preview instead of breaking it', async ({ page }) => {
  await titleInput(page).fill('');
  await expect(page.getByText('Preview paused')).toBeVisible();
  await expect(previewTitles(page)).toHaveCount(3);
  await expect(page.getByRole('form').getByText('Title is required')).toBeVisible();
});

test('adds, deletes and restores events from the toolbar', async ({ page }) => {
  await page.getByRole('button', { name: 'Add event' }).click();
  await expect(listItems(page)).toHaveCount(4);
  await expect(titleInput(page)).toHaveValue('New event');

  await page
    .getByRole('toolbar', { name: 'Edit' })
    .getByRole('button', { name: 'Delete event' })
    .click();
  await expect(listItems(page)).toHaveCount(3);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(listItems(page)).toHaveCount(4);
});

test('BCE dates and rich text render in the preview', async ({ page }) => {
  const dateGroup = page.getByRole('group', { name: 'Date' });
  await dateGroup.getByLabel('Date era').selectOption('bce');
  await dateGroup.getByLabel('Date year').fill('44');
  await dateGroup.getByLabel('Date month').selectOption('3');
  await dateGroup.getByLabel('Date day').selectOption('15');
  await expect(dateGroup.getByText('Shows as Mar 15, 44 BCE')).toBeVisible();
  await expect(preview(page).locator('.chronicle-event__date').first()).toHaveText(
    'Mar 15, 44 BCE',
  );

  const body = page.getByRole('textbox', { name: 'Event description' });
  await body.click();
  await page.keyboard.press(`${MOD}+a`);
  await page.keyboard.type('Beware the ');
  await page.keyboard.press(`${MOD}+b`);
  await page.keyboard.type('Ides');
  await expect(preview(page).locator('.chronicle-event__body strong').first()).toHaveText('Ides');
});

test('reorders events with the keyboard', async ({ page }) => {
  await page.getByRole('button', { name: 'Reorder Apollo 11 lands on the Moon' }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await expect(listItems(page).nth(1)).toContainText('Apollo 11');
});

test('renames an event inline in the preview', async ({ page }) => {
  await previewTitles(page).nth(1).dblclick();
  const inline = page.getByRole('textbox', { name: 'Event title' });
  await inline.fill('The Wall falls');
  await inline.press('Enter');
  await expect(previewTitles(page).nth(1)).toHaveText('The Wall falls');
});

test('imports a CSV with column mapping and date detection', async ({ page }) => {
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import events' });
  await dialog.locator('input[type=file]').setInputFiles({
    name: 'events.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'Headline,Date,Description,Tags\nPrinting press,c. 1440,Gutenberg,tech\nMagna Carta,15/06/1215,,law\nBroken,someday,,\n',
    ),
  });
  await expect(dialog.getByText('Day/Month/Year')).toBeVisible();
  await expect(dialog.getByText('2 events will be imported, 1 rows skipped')).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 events' }).click();

  await expect(dialog).toBeHidden();
  await expect(listItems(page)).toHaveCount(5);
  await expect(previewTitles(page).first()).toHaveText('Magna Carta');
  await expect(preview(page).locator('.chronicle-event__date').nth(1)).toHaveText('~1440');
});

test('reports JSON errors with line numbers', async ({ page }) => {
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import events' });
  await dialog.getByRole('tab', { name: 'JSON / TimelineJS' }).click();
  await dialog
    .getByLabel('…or paste JSON')
    .fill('{\n  "id": "t",\n  "title": "T",\n  "events": [{ "id": "a", "title": "A" }]\n}');
  await dialog.getByRole('button', { name: 'Check' }).click();
  await expect(dialog.getByRole('alert')).toContainText('line 4');
  await expect(dialog.getByRole('alert')).toContainText('Missing required field “date”');
});

test('exports valid JSON', async ({ page }) => {
  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /JSON/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('my-first-timeline.json');
  const target = test.info().outputPath('export.json');
  await download.saveAs(target);
  const { readFile } = await import('node:fs/promises');
  const json = JSON.parse(await readFile(target, 'utf8')) as { title: string; events: unknown[] };
  expect(json.title).toBe('My first timeline');
  expect(json.events).toHaveLength(3);
});

test('theme customisations apply to the preview', async ({ page }) => {
  await page.getByRole('tab', { name: 'Theme' }).click();
  await page.getByLabel('Accent (dates, buttons) colour').fill('#7c3aed');
  await expect
    .poll(() =>
      preview(page).evaluate((el) => {
        const container = el.shadowRoot?.querySelector('.chronicle-container');
        return container
          ? getComputedStyle(container).getPropertyValue('--chronicle-color-primary').trim()
          : '';
      }),
    )
    .toBe('#7c3aed');
  await expect(
    page.getByText(/All text colours meet WCAG AA|colour pairs? below WCAG AA/),
  ).toBeVisible();
});

test('keeps working offline and restores the draft after reload', async ({ page, context }) => {
  // Wait for the service worker to take control so the app shell is cached.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(previewTitles(page)).toHaveCount(3);
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true);

  await titleInput(page).fill('Edited while online');
  await expect.poll(() => savedEventTitles(page)).toContain('Edited while online');

  await context.setOffline(true);
  await page.reload();
  await expect(titleInput(page)).toHaveValue('Edited while online');
  await expect(page.getByText('Offline — your work is still saved locally')).toBeVisible();

  await titleInput(page).fill('Edited offline');
  await expect.poll(() => savedEventTitles(page)).toContain('Edited offline');
  await page.reload();
  await expect(titleInput(page)).toHaveValue('Edited offline');
  await context.setOffline(false);
});
