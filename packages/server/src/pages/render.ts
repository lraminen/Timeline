import type { Timeline, TimelineEvent } from '@chronicle/schema';
import { escapeHtml, markdownToHtml, markdownToText } from '@chronicle/core/markdown';
import { formatDate, sortEvents } from '@chronicle/core/dates';

export interface PageAssets {
  script: string;
  stylesheet: string;
}

export interface TimelinePageInput {
  timeline: Timeline;
  /** Absolute canonical URL of this page. */
  canonicalUrl: string;
  /** Absolute origin used to resolve relative media URLs. */
  publicUrl: string;
  version: number;
  publishedAt: Date;
  assets: PageAssets;
  /** Private (share-link) pages must not be indexed. */
  indexable: boolean;
}

const e = escapeHtml;

/** JSON for embedding in a <script> element: `<`, U+2028/2029 escaped. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** `YYYY`, `YYYY-MM`, `YYYY-MM-DD` for CE years — valid in <time datetime> and schema.org. */
function machineDate(value: string | undefined): string | undefined {
  return value && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(value) ? value : undefined;
}

function absolute(url: string, base: string): string | undefined {
  try {
    const u = new URL(url, `${base}/`);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function displayDate(evt: TimelineEvent, locale: string): string {
  if (evt.date.displayOverride) return evt.date.displayOverride;
  const opts = { approximate: evt.date.approximate, uncertain: evt.date.uncertain };
  const start = formatDate(evt.date.start, locale, opts);
  return evt.date.end ? `${start} – ${formatDate(evt.date.end, locale, opts)}` : start;
}

function firstImage(timeline: Timeline, base: string): { url: string; alt: string } | undefined {
  for (const evt of timeline.events) {
    const img = evt.media.find((m) => m.type === 'image' && !m.url.startsWith('data:'));
    const url = img ? absolute(img.url, base) : undefined;
    if (img && url) return { url, alt: img.alt ?? evt.title };
  }
  return undefined;
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

function structuredData(input: TimelinePageInput, events: TimelineEvent[], image?: string) {
  const { timeline, canonicalUrl, publicUrl } = input;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: timeline.title,
    ...(timeline.description ? { description: markdownToText(timeline.description) } : {}),
    url: canonicalUrl,
    numberOfItems: events.length,
    ...(image ? { image } : {}),
    itemListElement: events.map((evt, i) => {
      const eventImage = evt.media.find((m) => m.type === 'image');
      const imageUrl = eventImage ? absolute(eventImage.url, publicUrl) : undefined;
      return {
        '@type': 'ListItem',
        position: i + 1,
        item: {
          '@type': 'Event',
          name: evt.title,
          // BCE and other non-ISO dates cannot be expressed in schema.org dates.
          ...(machineDate(evt.date.start) ? { startDate: evt.date.start } : {}),
          ...(machineDate(evt.date.end) ? { endDate: evt.date.end } : {}),
          ...(evt.body ? { description: truncate(markdownToText(evt.body), 500) } : {}),
          ...(imageUrl ? { image: imageUrl } : {}),
          ...(evt.location
            ? {
                location: {
                  '@type': 'Place',
                  ...(evt.location.label ? { name: evt.location.label } : {}),
                  geo: {
                    '@type': 'GeoCoordinates',
                    latitude: evt.location.lat,
                    longitude: evt.location.lng,
                  },
                },
              }
            : {}),
        },
      };
    }),
  };
}

function renderEvent(evt: TimelineEvent, locale: string, base: string): string {
  const datetime = machineDate(evt.date.start);
  const image = evt.media.find((m) => m.type === 'image');
  const imageUrl = image
    ? image.url.startsWith('data:image/')
      ? image.url
      : absolute(image.url, base)
    : undefined;
  return `<li class="ssr-event">
  <article aria-labelledby="ev-${e(evt.id)}">
    <h2 id="ev-${e(evt.id)}">${e(evt.title)}</h2>
    <p class="ssr-date"><time${datetime ? ` datetime="${e(datetime)}"` : ''}>${e(displayDate(evt, locale))}</time></p>
    ${
      image && imageUrl
        ? `<figure><img src="${e(imageUrl)}" alt="${e(image.alt ?? '')}" loading="lazy" decoding="async">${
            image.caption || image.credit
              ? `<figcaption>${e([image.caption, image.credit ? `(${image.credit})` : ''].filter(Boolean).join(' '))}</figcaption>`
              : ''
          }</figure>`
        : ''
    }
    ${evt.body ? `<div class="ssr-body">${markdownToHtml(evt.body)}</div>` : ''}
    ${evt.tags.length ? `<p class="ssr-tags">${evt.tags.map((t) => `<span>#${e(t)}</span>`).join(' ')}</p>` : ''}
  </article>
</li>`;
}

/**
 * Full HTML page for a published timeline. The semantic event list is
 * server-rendered inside <chronicle-timeline> as light DOM: crawlers and
 * no-JS readers get real content; once the component upgrades, its shadow
 * root replaces the static list with the interactive timeline. Data reaches
 * the component through an inert JSON <script>, so the page needs no inline
 * JavaScript and runs under a strict CSP.
 */
export function renderTimelinePage(input: TimelinePageInput): string {
  const { timeline, canonicalUrl, publicUrl, assets } = input;
  const locale = timeline.settings.locale || 'en';
  const dir = locale.split('-')[0] === 'ar' ? 'rtl' : 'ltr';
  const events = sortEvents(timeline.events);
  const description = truncate(
    timeline.description
      ? markdownToText(timeline.description)
      : `${String(events.length)} events${events[0] ? `, starting with ${events[0].title}` : ''}.`,
    200,
  );
  const image = firstImage(timeline, publicUrl);

  return `<!doctype html>
<html lang="${e(locale)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(timeline.title)}</title>
<meta name="description" content="${e(description)}">
${input.indexable ? '' : '<meta name="robots" content="noindex, nofollow">\n'}<link rel="canonical" href="${e(canonicalUrl)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${e(timeline.title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${e(canonicalUrl)}">
${image ? `<meta property="og:image" content="${e(image.url)}">\n<meta property="og:image:alt" content="${e(image.alt)}">\n` : ''}<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${e(timeline.title)}">
<meta name="twitter:description" content="${e(description)}">
<meta name="generator" content="Chronicle">
<link rel="stylesheet" href="${e(assets.stylesheet)}">
<script type="application/ld+json">${jsonForScript(structuredData(input, events, image?.url))}</script>
<script src="${e(assets.script)}" defer></script>
</head>
<body>
<header class="page-header">
  <h1>${e(timeline.title)}</h1>
  ${timeline.description ? `<div class="page-description">${markdownToHtml(timeline.description)}</div>` : ''}
</header>
<main>
<chronicle-timeline class="page-timeline" aria-label="${e(timeline.title)}">
  <script type="application/json">${jsonForScript(timeline)}</script>
  <ol class="ssr-events">
${events.map((evt) => renderEvent(evt, locale, publicUrl)).join('\n')}
  </ol>
</chronicle-timeline>
</main>
<footer class="page-footer">
  <p>Version ${String(input.version)} · published <time datetime="${input.publishedAt.toISOString()}">${e(
    input.publishedAt.toISOString().slice(0, 10),
  )}</time> · made with Chronicle</p>
</footer>
</body>
</html>`;
}

export function renderNotFoundPage(assets: PageAssets): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Timeline not found</title>
<link rel="stylesheet" href="${e(assets.stylesheet)}">
</head>
<body>
<main class="not-found">
  <h1>Timeline not found</h1>
  <p>This timeline doesn’t exist, isn’t published yet, or is private. If someone shared it with you, check that the link is complete.</p>
</main>
</body>
</html>`;
}
