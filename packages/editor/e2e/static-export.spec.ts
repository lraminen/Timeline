import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unzipSync } from 'fflate';

test('exports a static site that works opened straight from disk, offline', async ({
  page,
  browser,
}) => {
  await page.goto('/');
  await expect(page.getByRole('form')).toBeVisible();

  await page.getByRole('button', { name: 'Export' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /Static site/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('my-first-timeline.zip');
  await expect(page.getByRole('status').filter({ hasText: 'works offline' })).toBeVisible();

  // Unzip into a folder, as a person would.
  const zipPath = test.info().outputPath('site.zip');
  await download.saveAs(zipPath);
  const dir = test.info().outputPath('unzipped');
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zipPath))))) {
    if (name.endsWith('/')) continue;
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  const index = path.join(dir, 'my-first-timeline', 'index.html');

  // A fresh browser with no network at all.
  const context = await browser.newContext();
  await context.setOffline(true);
  const site = await context.newPage();
  const problems: string[] = [];
  site.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  site.on('pageerror', (e) => problems.push(String(e)));
  await site.goto(pathToFileURL(index).href);

  await expect(site.getByRole('heading', { level: 1 })).toHaveText('My first timeline');
  // The interactive timeline upgrades and shows every event.
  await expect(site.locator('chronicle-timeline .chronicle-event')).toHaveCount(3);
  expect(await site.evaluate(() => customElements.get('chronicle-timeline') !== undefined)).toBe(
    true,
  );
  expect(problems).toEqual([]);

  const axe = await new AxeBuilder({ page: site }).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual(
    [],
  );

  // The archive documents itself.
  const manifest = JSON.parse(
    readFileSync(path.join(dir, 'my-first-timeline', 'manifest.json'), 'utf8'),
  ) as { generator: string; timeline: { events: number } };
  expect(manifest).toMatchObject({ generator: 'Chronicle editor', timeline: { events: 3 } });
  await context.close();
});
