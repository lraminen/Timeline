import { registerBlockType, createBlock, type BlockTransform } from '@wordpress/blocks';
import { editorConfig } from './api.js';
import { Edit, type TimelineAttributes } from './edit.js';
import { timelineIcon } from './icon.js';
import {
  formatTags,
  normalizeHeight,
  parseTags,
  parseTimelineInput,
  type TimelineRef,
} from './url.js';

const NAME = 'chronicle/timeline';

/** A pasted paragraph that is only a link to a timeline on the configured server. */
function pastedTimeline(node: Node): TimelineRef | null {
  const { serverUrl } = editorConfig();
  if (!serverUrl || node.nodeName !== 'P') return null;
  const text = (node.textContent ?? '').trim();
  if (!/^https?:\/\/\S+$/.test(text)) return null;
  const result = parseTimelineInput(text, serverUrl);
  // Only links to the configured server: other sites' /timeline/ URLs stay links.
  return result.ok && result.ref.server === '' ? result.ref : null;
}

const pick = <T extends string>(value: string | undefined, allowed: readonly T[]): T | '' =>
  allowed.find((a) => a === value) ?? '';

const transforms: BlockTransform[] = [
  {
    type: 'raw',
    // Ahead of core/embed, which converts any lone URL.
    priority: 5,
    isMatch: (node) => pastedTimeline(node) !== null,
    transform: (node) => createBlock(NAME, { ...pastedTimeline(node) }),
  },
  {
    type: 'shortcode',
    tag: 'chronicle',
    transform: ({ named }) => {
      const target = named.url ?? named.id ?? '';
      // As in PHP, a bare slug always means the configured server, even if
      // none is configured yet (the block then explains what is missing).
      const parsed = parseTimelineInput(
        target,
        editorConfig().serverUrl || 'https://configured.invalid',
      );
      const ref = parsed.ok ? parsed.ref : { server: '', slug: '', version: 0 };
      const pinned = Number(named.version ?? '');
      const attributes: Partial<TimelineAttributes> = {
        ...ref,
        version: Number.isInteger(pinned) && pinned > 0 ? pinned : ref.version,
        layout: pick(named.layout, ['horizontal', 'vertical', 'card'] as const),
        theme: pick(named.theme, ['light', 'dark', 'editorial', 'minimal'] as const),
        height: normalizeHeight(named.height ?? '') ?? '',
        filterTags: formatTags(parseTags(named.tags ?? '')),
      };
      if (named.align === 'wide' || named.align === 'full') {
        return createBlock(NAME, { ...attributes, align: named.align });
      }
      return createBlock(NAME, attributes);
    },
  },
];

registerBlockType<TimelineAttributes>(NAME, {
  icon: timelineIcon,
  edit: Edit,
  // Dynamic block: rendered by PHP so newly published versions show without re-saving.
  save: () => null,
  transforms: { from: transforms },
});
