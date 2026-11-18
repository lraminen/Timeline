import type { TimelineEvent } from '@chronicle/schema';
import type { TimelineMedia } from '@chronicle/schema';
import type { I18nContext } from '../types.js';
import { resolveMediaType, getOEmbedUrl, isSafeMediaUrl, EMBED_SANDBOX } from '../media.js';
import { h } from './dom.js';

/**
 * Renders a media element. Every URL is re-checked here even though the
 * schema validates it, because `TimelineRenderer` is public API and may be
 * handed unvalidated data.
 *
 * - img/video/audio: only safe schemes (http(s), relative, blob, matching data:).
 * - iframes: only URLs produced by `getOEmbedUrl` (allowlisted https
 *   providers), always sandboxed. Unknown embeds become a plain link.
 */
function renderMedia(media: TimelineMedia, title: string, i18n: I18nContext): HTMLElement | null {
  const type = resolveMediaType(media);

  if (type === 'image' || type === 'video' || type === 'audio') {
    if (!isSafeMediaUrl(media.url, type)) return null;
    if (type === 'image') {
      const img = h('img', { src: media.url, alt: media.alt || title, loading: 'lazy' });
      // Drop broken images rather than leave an empty frame; the renderer's
      // ResizeObserver picks up the height change and re-lays out.
      img.addEventListener('error', () => {
        img.remove();
      });
      return img;
    }
    return type === 'video'
      ? h('video', { src: media.url, controls: true, preload: 'metadata' })
      : h('audio', { src: media.url, controls: true, preload: 'metadata' });
  }

  // oembed / map
  const embedUrl = getOEmbedUrl(media.url);
  if (embedUrl) {
    return h('iframe', {
      src: embedUrl,
      sandbox: EMBED_SANDBOX,
      allow: 'encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: true,
      loading: 'lazy',
      referrerpolicy: 'strict-origin-when-cross-origin',
      title: media.caption || title,
    });
  }

  // Unknown provider: offer a link (http(s) only), never an iframe.
  if (isSafeMediaUrl(media.url) && /^(https?:)?\/\//i.test(media.url.trim())) {
    return h(
      'a',
      {
        class: 'chronicle-event__media-link',
        href: media.url,
        target: '_blank',
        rel: 'noopener noreferrer',
      },
      media.caption || i18n.strings.event.media,
    );
  }
  return null;
}

/** Dates that are valid in a `<time datetime>` attribute (CE, 4-digit year). */
const MACHINE_DATE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/**
 * Builds an event card. Positioning is applied separately by the renderer,
 * after the card has been measured.
 */
export function renderEventCard(
  event: TimelineEvent,
  i18n: I18nContext,
  options: { isActive: boolean },
): HTMLElement {
  const { date } = event;
  const modifiers = { uncertain: date.uncertain, approximate: date.approximate };
  const dateText =
    date.displayOverride ??
    (date.end
      ? i18n.formatDateRange(date.start, date.end, modifiers)
      : i18n.formatDate(date.start, modifiers));

  const card = h('article', {
    class: `chronicle-event${options.isActive ? ' chronicle-event--active' : ''}`,
    'data-event-id': event.id,
    tabindex: '0',
    role: 'listitem',
    'aria-label': `${event.title}, ${dateText}`,
  });

  const dateEl = h(
    'time',
    {
      class: 'chronicle-event__date',
      datetime: MACHINE_DATE.test(date.start) ? date.start : undefined,
    },
    dateText,
  );

  const header = h('div', { class: 'chronicle-event__header' }, dateEl);
  card.appendChild(header);

  // Title
  const titleEl = h('h3', { class: 'chronicle-event__title' }, event.title);
  card.appendChild(titleEl);

  // Media (if any)
  if (event.media.length > 0) {
    const primaryMedia = event.media[0];
    const mediaContainer = h('div', { class: 'chronicle-event__media' });

    const element = renderMedia(primaryMedia, event.title, i18n);
    if (element) mediaContainer.appendChild(element);

    if (primaryMedia.caption || primaryMedia.credit) {
      const captionText = [
        primaryMedia.caption,
        primaryMedia.credit ? `(${primaryMedia.credit})` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const cap = h('div', { class: 'chronicle-event__media-caption' }, captionText);
      mediaContainer.appendChild(cap);
    }

    card.appendChild(mediaContainer);
  }

  // Body
  if (event.body) {
    const bodyEl = h('p', { class: 'chronicle-event__body' }, event.body);
    card.appendChild(bodyEl);
  }

  // Tags
  if (event.tags.length > 0) {
    const tagsContainer = h('div', { class: 'chronicle-event__tags' });
    for (const tag of event.tags) {
      const tagEl = h('span', { class: 'chronicle-event__tag' }, `#${tag}`);
      tagsContainer.appendChild(tagEl);
    }
    card.appendChild(tagsContainer);
  }

  return card;
}
