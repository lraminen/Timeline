import { createElement, useEffect, useMemo, useRef, useState } from '@wordpress/element';
import { __, sprintf } from '@wordpress/i18n';
import { BlockControls, InspectorControls, useBlockProps } from '@wordpress/block-editor';
import type { BlockEditProps } from '@wordpress/blocks';
import {
  Button,
  ExternalLink,
  FormTokenField,
  Notice,
  PanelBody,
  Placeholder,
  SelectControl,
  Spinner,
  TextControl,
  ToggleControl,
  ToolbarButton,
  ToolbarGroup,
} from '@wordpress/components';
import {
  editorConfig,
  errorMessage,
  fetchPreview,
  listTimelines,
  type TimelinePreview,
  type TimelineSummary,
} from './api.js';
import {
  formatTags,
  jsonForScript,
  normalizeHeight,
  parseTags,
  parseTimelineInput,
  type TimelineRef,
} from './url.js';
import { timelineIcon } from './icon.js';

export interface TimelineAttributes {
  slug: string;
  server: string;
  version: number;
  layout: '' | 'horizontal' | 'vertical' | 'card';
  theme: '' | 'light' | 'dark' | 'editorial' | 'minimal';
  height: string;
  filterTags: string;
}

function layoutOptions() {
  return [
    { value: '', label: __('As set in the timeline', 'chronicle-timeline') },
    { value: 'vertical', label: __('Vertical', 'chronicle-timeline') },
    { value: 'horizontal', label: __('Horizontal', 'chronicle-timeline') },
    { value: 'card', label: __('Cards', 'chronicle-timeline') },
  ];
}

function themeOptions() {
  return [
    { value: '', label: __('As set in the timeline', 'chronicle-timeline') },
    { value: 'light', label: __('Light', 'chronicle-timeline') },
    { value: 'dark', label: __('Dark', 'chronicle-timeline') },
    { value: 'editorial', label: __('Editorial', 'chronicle-timeline') },
    { value: 'minimal', label: __('Minimal', 'chronicle-timeline') },
  ];
}

function parseError(reason: 'invalid' | 'share-link' | 'insecure'): string {
  switch (reason) {
    case 'share-link':
      return __(
        'This is a private share link, which expires. Make the timeline public in Chronicle and use its public link instead.',
        'chronicle-timeline',
      );
    case 'insecure':
      return __('Timelines from other Chronicle servers must use https.', 'chronicle-timeline');
    case 'invalid':
      return __(
        'That is not a Chronicle timeline link. It should look like https://…/timeline/my-timeline.',
        'chronicle-timeline',
      );
  }
}

type ListState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; timelines: TimelineSummary[] }
  | { status: 'error'; message: string };

/** Choose a timeline from the connected account, or paste a link. */
function TimelinePicker({
  onPick,
  onCancel,
}: {
  onPick: (ref: TimelineRef) => void;
  onCancel?: () => void;
}) {
  const config = editorConfig();
  const [list, setList] = useState<ListState>({ status: 'idle' });
  const [selected, setSelected] = useState('');
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    if (!config.hasAccount) return;
    let live = true;
    setList({ status: 'loading' });
    listTimelines().then(
      (res) => {
        if (live) setList({ status: 'ready', timelines: res.timelines });
      },
      (error: unknown) => {
        if (live) setList({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [config.hasAccount]);

  const submitLink = () => {
    const result = parseTimelineInput(link, config.serverUrl);
    if (result.ok) {
      setLinkError('');
      onPick(result.ref);
    } else {
      setLinkError(parseError(result.reason));
    }
  };

  const options =
    list.status === 'ready'
      ? [
          { value: '', label: __('— Choose a timeline —', 'chronicle-timeline') },
          ...list.timelines.map((t) => ({
            value: t.slug,
            disabled: !t.embeddable,
            label: t.embeddable
              ? t.title
              : sprintf(
                  /* translators: %s: timeline title */
                  t.publishedVersion === null
                    ? __('%s (not published yet)', 'chronicle-timeline')
                    : __('%s (private)', 'chronicle-timeline'),
                  t.title,
                ),
          })),
        ]
      : [];

  return (
    <Placeholder
      icon={timelineIcon}
      label={__('Chronicle Timeline', 'chronicle-timeline')}
      instructions={__('Embed a published, public Chronicle timeline.', 'chronicle-timeline')}
      className="chronicle-timeline-editor__placeholder"
    >
      <div className="chronicle-timeline-editor__picker">
        {config.hasAccount && list.status === 'loading' && (
          <div className="chronicle-timeline-editor__status">
            <Spinner /> {__('Loading your timelines…', 'chronicle-timeline')}
          </div>
        )}
        {list.status === 'error' && (
          <Notice status="error" isDismissible={false}>
            {sprintf(
              /* translators: %s: error message */
              __('Could not load your timelines: %s', 'chronicle-timeline'),
              list.message,
            )}
          </Notice>
        )}
        {list.status === 'ready' && list.timelines.length === 0 && (
          <p>{__('Your Chronicle account has no timelines yet.', 'chronicle-timeline')}</p>
        )}
        {list.status === 'ready' && list.timelines.length > 0 && (
          <div className="chronicle-timeline-editor__row">
            <SelectControl
              label={__('Your timelines', 'chronicle-timeline')}
              value={selected}
              options={options}
              onChange={setSelected}
              __next40pxDefaultSize
              __nextHasNoMarginBottom
            />
            <Button
              variant="primary"
              disabled={!selected}
              onClick={() => {
                onPick({ server: '', slug: selected, version: 0 });
              }}
              __next40pxDefaultSize
            >
              {__('Embed', 'chronicle-timeline')}
            </Button>
          </div>
        )}
        {!config.hasAccount && config.settingsUrl && (
          <p>
            <ExternalLink href={config.settingsUrl}>
              {__('Connect your Chronicle account', 'chronicle-timeline')}
            </ExternalLink>{' '}
            {__('to choose from your timelines, or paste a link below.', 'chronicle-timeline')}
          </p>
        )}
        <form
          className="chronicle-timeline-editor__row"
          onSubmit={(e) => {
            e.preventDefault();
            submitLink();
          }}
        >
          <TextControl
            label={
              config.serverUrl
                ? __('Timeline link or slug', 'chronicle-timeline')
                : __('Timeline link', 'chronicle-timeline')
            }
            placeholder="https://…/timeline/my-timeline"
            value={link}
            onChange={(value) => {
              setLink(value);
              setLinkError('');
            }}
            __next40pxDefaultSize
            __nextHasNoMarginBottom
          />
          <Button variant="secondary" type="submit" disabled={!link.trim()} __next40pxDefaultSize>
            {__('Embed link', 'chronicle-timeline')}
          </Button>
        </form>
        {linkError && (
          <Notice status="error" isDismissible={false}>
            {linkError}
          </Notice>
        )}
        {onCancel && (
          <div>
            <Button variant="link" onClick={onCancel}>
              {__('Cancel', 'chronicle-timeline')}
            </Button>
          </div>
        )}
      </div>
    </Placeholder>
  );
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; preview: TimelinePreview }
  | { status: 'error'; message: string };

function usePreview(ref: TimelineRef): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const { server, slug, version } = ref;
  useEffect(() => {
    if (!slug) return;
    let live = true;
    setState({ status: 'loading' });
    fetchPreview({ server, slug, version }).then(
      (preview) => {
        if (live) setState({ status: 'ready', preview });
      },
      (error: unknown) => {
        if (live) setState({ status: 'error', message: errorMessage(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [server, slug, version]);
  return state;
}

/** The real web component, fed through an inert JSON child like the front end. */
function TimelineElement({
  preview,
  attributes,
}: {
  preview: TimelinePreview;
  attributes: TimelineAttributes;
}) {
  const config = editorConfig();
  const ref = useRef<HTMLElement | null>(null);
  const [renderError, setRenderError] = useState('');
  const json = useMemo(() => jsonForScript(preview.timeline), [preview.timeline]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onError = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string }>).detail;
      setRenderError(
        detail.message ?? __('The timeline could not be displayed.', 'chronicle-timeline'),
      );
    };
    el.addEventListener('chronicle:error', onError);
    return () => {
      el.removeEventListener('chronicle:error', onError);
    };
  }, [json]);

  const props: Record<string, unknown> = {
    // A new element whenever the data changes: the component reads its JSON child once.
    key: json,
    ref,
    'aria-label': preview.timeline.title ?? __('Timeline', 'chronicle-timeline'),
  };
  const layout = attributes.layout || config.defaultLayout;
  const theme = attributes.theme || config.defaultTheme;
  if (layout) props.layout = layout;
  if (theme) props.theme = theme;
  const height = normalizeHeight(attributes.height);
  if (height) props.height = height;
  if (attributes.filterTags) props['filter-tags'] = attributes.filterTags;

  return (
    <>
      {renderError && (
        <Notice status="error" isDismissible={false}>
          {renderError}
        </Notice>
      )}
      {createElement(
        'chronicle-timeline',
        props,
        createElement('script', {
          type: 'application/json',
          dangerouslySetInnerHTML: { __html: json },
        }),
      )}
    </>
  );
}

export function Edit({ attributes, setAttributes }: BlockEditProps<TimelineAttributes>) {
  const blockProps = useBlockProps({ className: 'chronicle-timeline-editor__preview' });
  const [picking, setPicking] = useState(!attributes.slug);
  const { server, slug, version } = attributes;
  const preview = usePreview({ server, slug, version });
  const [heightInput, setHeightInput] = useState(attributes.height);

  const tagSuggestions = useMemo(() => {
    if (preview.status !== 'ready') return [];
    const tags = new Set<string>();
    for (const evt of preview.preview.timeline.events ?? []) {
      for (const tag of evt.tags ?? []) tags.add(tag);
    }
    return [...tags].sort();
  }, [preview]);

  if (picking || !slug) {
    return (
      <div {...blockProps}>
        <TimelinePicker
          onPick={(ref) => {
            setAttributes({ server: ref.server, slug: ref.slug, version: ref.version });
            setPicking(false);
          }}
          onCancel={
            slug
              ? () => {
                  setPicking(false);
                }
              : undefined
          }
        />
      </div>
    );
  }

  const heightValid = normalizeHeight(heightInput) !== null;
  const current = preview.status === 'ready' ? preview.preview : null;

  return (
    <>
      <BlockControls>
        <ToolbarGroup>
          <ToolbarButton
            onClick={() => {
              setPicking(true);
            }}
          >
            {__('Replace', 'chronicle-timeline')}
          </ToolbarButton>
        </ToolbarGroup>
      </BlockControls>
      <InspectorControls>
        <PanelBody title={__('Timeline', 'chronicle-timeline')}>
          {current && (
            <p>
              <strong>{current.timeline.title}</strong>
              {current.pageUrl && (
                <>
                  <br />
                  <ExternalLink href={current.pageUrl}>
                    {__('View in Chronicle', 'chronicle-timeline')}
                  </ExternalLink>
                </>
              )}
            </p>
          )}
          <ToggleControl
            label={
              version > 0
                ? sprintf(
                    /* translators: %d: version number */
                    __('Pinned to version %d', 'chronicle-timeline'),
                    version,
                  )
                : __('Pin to the current version', 'chronicle-timeline')
            }
            help={
              version > 0
                ? __(
                    'Newer versions published in Chronicle will not appear here.',
                    'chronicle-timeline',
                  )
                : __(
                    'Off: this block always shows the latest published version.',
                    'chronicle-timeline',
                  )
            }
            checked={version > 0}
            onChange={(pin) => {
              setAttributes({ version: pin && current ? current.version : 0 });
            }}
            __nextHasNoMarginBottom
          />
        </PanelBody>
        <PanelBody title={__('Display', 'chronicle-timeline')}>
          <SelectControl
            label={__('Layout', 'chronicle-timeline')}
            value={attributes.layout}
            options={layoutOptions()}
            onChange={(value) => {
              setAttributes({ layout: value as TimelineAttributes['layout'] });
            }}
            __next40pxDefaultSize
            __nextHasNoMarginBottom
          />
          <SelectControl
            label={__('Theme', 'chronicle-timeline')}
            value={attributes.theme}
            options={themeOptions()}
            onChange={(value) => {
              setAttributes({ theme: value as TimelineAttributes['theme'] });
            }}
            __next40pxDefaultSize
            __nextHasNoMarginBottom
          />
          <TextControl
            label={__('Height', 'chronicle-timeline')}
            value={heightInput}
            placeholder={__('Automatic', 'chronicle-timeline')}
            help={
              heightValid
                ? __('For example 600px, 80vh or 40rem. Empty for automatic.', 'chronicle-timeline')
                : __(
                    'Use a number with px, vh, rem or em, between 10 and 9999.',
                    'chronicle-timeline',
                  )
            }
            onChange={(value) => {
              setHeightInput(value);
              const normalized = normalizeHeight(value);
              if (normalized !== null) setAttributes({ height: normalized });
            }}
            __next40pxDefaultSize
            __nextHasNoMarginBottom
          />
          <FormTokenField
            label={__('Only show events tagged', 'chronicle-timeline')}
            value={parseTags(attributes.filterTags)}
            suggestions={tagSuggestions}
            onChange={(tokens) => {
              setAttributes({
                filterTags: formatTags(tokens.map((t) => (typeof t === 'string' ? t : t.value))),
              });
            }}
            __experimentalExpandOnFocus
            __next40pxDefaultSize
            __nextHasNoMarginBottom
          />
        </PanelBody>
      </InspectorControls>
      <div {...blockProps}>
        {preview.status === 'loading' && (
          <div className="chronicle-timeline-editor__status">
            <Spinner /> {__('Loading timeline…', 'chronicle-timeline')}
          </div>
        )}
        {preview.status === 'error' && (
          <Placeholder icon={timelineIcon} label={__('Chronicle Timeline', 'chronicle-timeline')}>
            <Notice status="error" isDismissible={false}>
              {sprintf(
                /* translators: %s: error message */
                __('This timeline cannot be shown: %s', 'chronicle-timeline'),
                preview.message,
              )}
            </Notice>
            <Button
              variant="secondary"
              onClick={() => {
                setPicking(true);
              }}
            >
              {__('Choose another timeline', 'chronicle-timeline')}
            </Button>
          </Placeholder>
        )}
        {current && <TimelineElement preview={current} attributes={attributes} />}
      </div>
    </>
  );
}
