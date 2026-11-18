import { ChronicleTimeline } from './chronicle-timeline.js';

// Register custom element if not already registered
if (typeof customElements !== 'undefined' && !customElements.get('chronicle-timeline')) {
  customElements.define('chronicle-timeline', ChronicleTimeline);
}

export { ChronicleTimeline };
