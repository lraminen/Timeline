import type { TimelineEvent } from "@chronicle/schema";
import type { LayoutPosition, I18nContext } from "../types.js";
import { resolveMediaType, getOEmbedUrl } from "../media.js";
import { h } from "./dom.js";

export function renderEventCard(
  event: TimelineEvent,
  position: LayoutPosition,
  i18n: I18nContext,
  options: { isActive: boolean; reducedMotion: boolean }
): HTMLElement {
  const card = h("article", {
    class: `chronicle-event chronicle-event--${position.side}${options.isActive ? " chronicle-event--active" : ""}`,
    "data-event-id": event.id,
    tabindex: "0",
    role: "listitem",
    "aria-label": event.title,
  });

  // Apply layout positioning if not a static stacked card
  if (position.side !== "center") {
    card.style.left = `${position.x}px`;
    card.style.top = `${position.y}px`;
    card.style.width = `${position.width}px`;
  }

  // Header: Date & Era tag
  const dateFormatted = i18n.formatDate(event.date.start, {
    uncertain: event.date.uncertain,
    approximate: event.date.approximate,
  });
  const dateEl = h("time", { class: "chronicle-event__date" }, dateFormatted);

  const header = h("div", { class: "chronicle-event__header" }, dateEl);
  card.appendChild(header);

  // Title
  const titleEl = h("h3", { class: "chronicle-event__title" }, event.title);
  card.appendChild(titleEl);

  // Media (if any)
  if (event.media && event.media.length > 0) {
    const primaryMedia = event.media[0];
    const mediaContainer = h("div", { class: "chronicle-event__media" });

    const displayType = resolveMediaType(primaryMedia);

    if (displayType === "image") {
      const img = h("img", {
        src: primaryMedia.url,
        alt: primaryMedia.alt || event.title,
        loading: "lazy",
      });
      mediaContainer.appendChild(img);
    } else if (displayType === "video") {
      const vid = h("video", {
        src: primaryMedia.url,
        controls: "true",
        preload: "metadata",
      });
      mediaContainer.appendChild(vid);
    } else if (displayType === "audio") {
      const aud = h("audio", {
        src: primaryMedia.url,
        controls: "true",
      });
      mediaContainer.appendChild(aud);
    } else if (displayType === "iframe") {
      const embedUrl = getOEmbedUrl(primaryMedia.url) || primaryMedia.url;
      const iframe = h("iframe", {
        src: embedUrl,
        allow: "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture",
        allowfullscreen: "true",
        title: primaryMedia.caption || event.title,
      });
      mediaContainer.appendChild(iframe);
    }

    if (primaryMedia.caption || primaryMedia.credit) {
      const captionText = [primaryMedia.caption, primaryMedia.credit ? `(${primaryMedia.credit})` : ""]
        .filter(Boolean)
        .join(" ");
      const cap = h("div", { class: "chronicle-event__media-caption" }, captionText);
      mediaContainer.appendChild(cap);
    }

    card.appendChild(mediaContainer);
  }

  // Body
  if (event.body) {
    const bodyEl = h("p", { class: "chronicle-event__body" }, event.body);
    card.appendChild(bodyEl);
  }

  // Tags
  if (event.tags && event.tags.length > 0) {
    const tagsContainer = h("div", { class: "chronicle-event__tags" });
    for (const tag of event.tags) {
      const tagEl = h("span", { class: "chronicle-event__tag" }, `#${tag}`);
      tagsContainer.appendChild(tagEl);
    }
    card.appendChild(tagsContainer);
  }

  return card;
}
