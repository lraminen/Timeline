export const BASE_STYLES = `
:host {
  display: block;
  box-sizing: border-box;
  font-family: var(--chronicle-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  font-size: var(--chronicle-font-size-base, 15px);
  line-height: var(--chronicle-line-height, 1.6);
  color: var(--chronicle-color-text, #0f172a);
  background-color: var(--chronicle-color-background, #f8fafc);
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.chronicle-container {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  background-color: var(--chronicle-color-background, #f8fafc);
}

/* Screen reader utility */
.chronicle-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* Skip link */
.chronicle-skip-link {
  position: absolute;
  top: -40px;
  left: 16px;
  background: var(--chronicle-color-primary, #2563eb);
  color: var(--chronicle-color-text-inverse, #ffffff);
  padding: 8px 16px;
  border-radius: var(--chronicle-radius-md, 8px);
  z-index: 100;
  text-decoration: none;
  font-weight: var(--chronicle-font-weight-medium, 500);
  transition: top var(--chronicle-transition-fast, 150ms ease-in-out);
}
.chronicle-skip-link:focus {
  top: 16px;
}

/* Controls header */
.chronicle-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 24px;
  background-color: var(--chronicle-color-surface, #ffffff);
  border-bottom: 1px solid var(--chronicle-color-border, #e2e8f0);
  position: sticky;
  top: 0;
  z-index: 20;
}

.chronicle-search {
  flex: 1 1 240px;
  max-width: 400px;
  position: relative;
}

.chronicle-search__input {
  width: 100%;
  padding: 8px 12px 8px 36px;
  border: 1px solid var(--chronicle-color-border, #e2e8f0);
  border-radius: var(--chronicle-radius-md, 8px);
  background-color: var(--chronicle-color-surface-alt, #f1f5f9);
  color: var(--chronicle-color-text, #0f172a);
  font-size: var(--chronicle-font-size-sm, 13px);
  outline: none;
  transition: border-color var(--chronicle-transition-fast, 150ms);
}
.chronicle-search__input:focus {
  border-color: var(--chronicle-color-primary, #2563eb);
  box-shadow: 0 0 0 2px var(--chronicle-color-primary-light, #dbeafe);
}

.chronicle-search__icon {
  position: absolute;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  fill: var(--chronicle-color-text-secondary, #64748b);
  pointer-events: none;
}

.chronicle-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.chronicle-filter-btn {
  padding: 6px 12px;
  border: 1px solid var(--chronicle-color-border, #e2e8f0);
  border-radius: var(--chronicle-radius-full, 9999px);
  background-color: var(--chronicle-color-surface, #ffffff);
  color: var(--chronicle-color-text-secondary, #64748b);
  font-size: var(--chronicle-font-size-sm, 13px);
  cursor: pointer;
  transition: all var(--chronicle-transition-fast, 150ms);
}
.chronicle-filter-btn:hover {
  background-color: var(--chronicle-color-surface-alt, #f1f5f9);
  color: var(--chronicle-color-text, #0f172a);
}
.chronicle-filter-btn--active {
  background-color: var(--chronicle-color-primary, #2563eb);
  color: var(--chronicle-color-text-inverse, #ffffff);
  border-color: var(--chronicle-color-primary, #2563eb);
}

.chronicle-zoom {
  display: flex;
  align-items: center;
  gap: 4px;
}

.chronicle-zoom-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--chronicle-color-border, #e2e8f0);
  border-radius: var(--chronicle-radius-md, 8px);
  background: var(--chronicle-color-surface, #ffffff);
  color: var(--chronicle-color-text, #0f172a);
  cursor: pointer;
  font-weight: bold;
}
.chronicle-zoom-btn:hover {
  background-color: var(--chronicle-color-surface-alt, #f1f5f9);
}

/* Timeline viewport / track */
.chronicle-viewport {
  flex: 1;
  position: relative;
  width: 100%;
}

/* Vertical layout */
.chronicle-container--vertical .chronicle-viewport {
  padding: 24px 16px;
}

.chronicle-axis--vertical {
  position: absolute;
  top: 48px;
  bottom: 48px;
  width: 2px;
  background-color: var(--chronicle-color-axis-line, #cbd5e1);
  transform: translateX(-50%);
  z-index: 1;
}

/* Horizontal layout */
.chronicle-container--horizontal {
  overflow-x: auto;
  overflow-y: hidden;
}

.chronicle-container--horizontal .chronicle-viewport {
  height: 100%;
  min-height: 500px;
}

.chronicle-axis--horizontal {
  position: absolute;
  left: 64px;
  right: 64px;
  height: 2px;
  background-color: var(--chronicle-color-axis-line, #cbd5e1);
  transform: translateY(-50%);
  z-index: 1;
}

/* Era bands */
.chronicle-era-band {
  position: absolute;
  background-color: var(--chronicle-color-era-background, rgba(37, 99, 235, 0.06));
  border-radius: var(--chronicle-radius-md, 8px);
  z-index: 0;
  pointer-events: none;
}

.chronicle-era-band__label {
  position: absolute;
  top: 8px;
  left: 12px;
  font-size: var(--chronicle-font-size-sm, 13px);
  font-weight: var(--chronicle-font-weight-medium, 500);
  color: var(--chronicle-color-primary, #2563eb);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.8;
}

/* Events */
.chronicle-event {
  position: absolute;
  display: flex;
  flex-direction: column;
  background-color: var(--chronicle-color-surface, #ffffff);
  border: 1px solid var(--chronicle-color-border, #e2e8f0);
  border-radius: var(--chronicle-radius-lg, 12px);
  box-shadow: var(--chronicle-shadow-sm, 0 1px 2px 0 rgba(0,0,0,0.05));
  padding: 16px 20px;
  cursor: pointer;
  z-index: 2;
  transition: transform var(--chronicle-transition-normal, 250ms),
              box-shadow var(--chronicle-transition-normal, 250ms),
              border-color var(--chronicle-transition-normal, 250ms);
}

.chronicle-event:hover {
  transform: translateY(-2px);
  box-shadow: var(--chronicle-shadow-md, 0 4px 6px -1px rgba(0,0,0,0.1));
  border-color: var(--chronicle-color-primary-light, #dbeafe);
}

.chronicle-event:focus-visible,
.chronicle-event--active {
  outline: none;
  border-color: var(--chronicle-color-primary, #2563eb);
  box-shadow: 0 0 0 3px var(--chronicle-color-primary-light, #dbeafe),
              var(--chronicle-shadow-md, 0 4px 6px -1px rgba(0,0,0,0.1));
}

/* Markers */
.chronicle-marker {
  position: absolute;
  width: 14px;
  height: 14px;
  border-radius: var(--chronicle-radius-full, 9999px);
  background-color: var(--chronicle-color-surface, #ffffff);
  border: 3px solid var(--chronicle-color-marker, #2563eb);
  transform: translate(-50%, -50%);
  z-index: 3;
  transition: transform var(--chronicle-transition-fast, 150ms),
              background-color var(--chronicle-transition-fast, 150ms);
}

.chronicle-event--active .chronicle-marker,
.chronicle-marker--active {
  background-color: var(--chronicle-color-marker-active, #1d4ed8);
  transform: translate(-50%, -50%) scale(1.3);
}

/* Card layout overrides */
.chronicle-container--card .chronicle-viewport {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 32px 16px;
  gap: 24px;
}

.chronicle-container--card .chronicle-event {
  position: relative;
  width: 100%;
  max-width: 680px;
}

/* Event internal elements */
.chronicle-event__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.chronicle-event__date {
  font-size: var(--chronicle-font-size-sm, 13px);
  font-weight: var(--chronicle-font-weight-medium, 500);
  color: var(--chronicle-color-primary, #2563eb);
}

.chronicle-event__title {
  font-size: var(--chronicle-font-size-lg, 17px);
  font-weight: var(--chronicle-font-weight-bold, 600);
  color: var(--chronicle-color-text, #0f172a);
  margin: 0 0 8px 0;
  line-height: 1.35;
}

.chronicle-event__body {
  font-size: var(--chronicle-font-size-base, 15px);
  color: var(--chronicle-color-text-secondary, #64748b);
  margin: 0 0 12px 0;
  line-height: 1.5;
}

.chronicle-event__media {
  margin: 8px 0 12px 0;
  border-radius: var(--chronicle-radius-md, 8px);
  overflow: hidden;
  background-color: var(--chronicle-color-surface-alt, #f1f5f9);
}

.chronicle-event__media img,
.chronicle-event__media video,
.chronicle-event__media iframe {
  width: 100%;
  height: auto;
  max-height: var(--chronicle-media-max-height, 360px);
  object-fit: cover;
  display: block;
  border: none;
}

.chronicle-event__media-caption {
  padding: 6px 10px;
  font-size: var(--chronicle-font-size-sm, 13px);
  color: var(--chronicle-color-text-secondary, #64748b);
  background: var(--chronicle-color-surface-alt, #f1f5f9);
}

.chronicle-event__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}

.chronicle-event__tag {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: var(--chronicle-font-weight-medium, 500);
  background-color: var(--chronicle-color-surface-alt, #f1f5f9);
  color: var(--chronicle-color-text-secondary, #64748b);
  border-radius: var(--chronicle-radius-full, 9999px);
}

/* Empty state */
.chronicle-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 24px;
  text-align: center;
  color: var(--chronicle-color-text-secondary, #64748b);
  font-size: var(--chronicle-font-size-lg, 17px);
}

/* RTL overrides */
:host([dir="rtl"]) .chronicle-search__input,
[dir="rtl"] .chronicle-search__input {
  padding: 8px 36px 8px 12px;
}

:host([dir="rtl"]) .chronicle-search__icon,
[dir="rtl"] .chronicle-search__icon {
  left: auto;
  right: 12px;
}

/* Reduced motion */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
  }
}
`;
