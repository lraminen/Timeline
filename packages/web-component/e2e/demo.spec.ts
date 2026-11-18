import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const TIMELINES = ['timeline-vertical', 'timeline-horizontal', 'timeline-card', 'timeline-dark'];
const EVENT_COUNT = 8;

interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Page-relative boxes of every card in a timeline (pierces the shadow root). */
async function cardBoxes(page: Page, hostId: string): Promise<Box[]> {
  return page.evaluate((id) => {
    const root = document.getElementById(id)?.shadowRoot;
    return Array.from(root?.querySelectorAll<HTMLElement>('.chronicle-event') ?? []).map((c) => {
      // Offsets within the viewport element are scroll-independent.
      return {
        id: c.dataset.eventId ?? '',
        x: c.offsetLeft,
        y: c.offsetTop,
        w: c.offsetWidth,
        h: c.offsetHeight,
      };
    });
  }, hostId);
}

function overlapping(boxes: Box[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        hits.push(`${a.id} × ${b.id}`);
      }
    }
  }
  return hits;
}

/** Id of the focused element inside a timeline's shadow root. */
async function focusedInside(page: Page, hostId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const active = document.getElementById(id)?.shadowRoot?.activeElement;
    if (!active) return null;
    return (active as HTMLElement).dataset.eventId ?? active.className;
  }, hostId);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    document.addEventListener('chronicle:error', (e) => {
      throw new Error(`chronicle:error ${JSON.stringify((e as CustomEvent).detail)}`);
    });
  });
  await page.goto('/demo/index.html');
  for (const id of TIMELINES) {
    await expect(page.locator(`#${id} .chronicle-event`)).toHaveCount(EVENT_COUNT);
  }
  // Let images load/fail and any resulting relayout settle.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test.describe('layout', () => {
  for (const id of TIMELINES) {
    test(`${id}: no two event cards overlap`, async ({ page }) => {
      expect(overlapping(await cardBoxes(page, id))).toEqual([]);
    });
  }
});

test.describe('interaction', () => {
  test('search filters results and keeps focus while typing', async ({ page }) => {
    const input = page.locator('#timeline-vertical .chronicle-search__input');
    await input.click();
    await input.pressSequentially('apollo', { delay: 40 });
    await expect(page.locator('#timeline-vertical .chronicle-event')).toHaveCount(1);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('apollo');
  });

  test('arrow/Home/End keys stay in the search box', async ({ page }) => {
    const input = page.locator('#timeline-vertical .chronicle-search__input');
    await input.fill('moon');
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      await input.press(key);
      await expect(input).toBeFocused();
    }
  });

  test('arrow keys move between event cards', async ({ page }) => {
    const cards = page.locator('#timeline-vertical .chronicle-event');
    await cards.first().focus();
    await page.keyboard.press('ArrowDown');
    expect(await focusedInside(page, 'timeline-vertical')).toBe(
      await cards.nth(1).getAttribute('data-event-id'),
    );
    await page.keyboard.press('End');
    expect(await focusedInside(page, 'timeline-vertical')).toBe(
      await cards.last().getAttribute('data-event-id'),
    );
  });

  test('tag filter keeps focus on the pressed button', async ({ page }) => {
    const btn = page.locator('#timeline-vertical .chronicle-filter-btn[data-tag="moon"]');
    await btn.click();
    await expect(btn).toBeFocused();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#timeline-vertical .chronicle-event')).toHaveCount(1);
  });
});

test.describe('accessibility (axe-core)', () => {
  for (const id of TIMELINES) {
    test(`${id}: no serious or critical violations`, async ({ page }) => {
      const results = await new AxeBuilder({ page })
        .include(`#${id}`)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const serious = results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .flatMap((v) =>
          v.nodes.map(
            (n) =>
              `${v.id}: ${JSON.stringify(n.target)} — ${(n.failureSummary ?? '').replace(/\s+/g, ' ')}`,
          ),
        );
      expect(serious).toEqual([]);
    });
  }
});
