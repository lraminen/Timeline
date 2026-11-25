import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCloud, type Api } from '../cloud/cloud-store.js';
import { useEditor } from '../store/editor-store.js';
import { createBlankTimeline } from '../lib/document.js';
import { AiExtractImport } from './import/AiExtractImport.js';
import { DateField } from './inspector/DateField.js';
import { Inspector } from './inspector/Inspector.js';
import { ConflictsDialog } from './ConflictsDialog.js';

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    origin: 'https://api.test',
    refresh: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    listProjects: vi.fn(),
    createProject: vi.fn(),
    getProject: vi.fn(),
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    setVisibility: vi.fn(),
    publish: vi.fn(),
    createShareLink: vi.fn(),
    uploadMedia: vi.fn(),
    listApiKeys: vi.fn(),
    createApiKey: vi.fn(),
    revokeApiKey: vi.fn(),
    pageUrl: vi.fn(),
    embedUrl: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  const doc = createBlankTimeline('Test');
  doc.events = [
    {
      id: 'evt-1',
      title: 'Apollo 11',
      date: { start: '1969-07-20' },
      body: 'Long narrative description about Apollo 11 landing on the Moon.',
      media: [{ type: 'image', url: 'https://example.com/moon.jpg', alt: '' }],
      tags: ['space'],
    },
  ];
  useEditor.getState().load(doc);
  useCloud.setState({ api: null, user: null, checking: false });
});

describe('Phase 5 Editor AI UI', () => {
  it('exposes exact accessible fieldset names and parses natural-language dates explicitly', () => {
    const onApply = vi.fn();
    render(
      <DateField legend="Date" value="1969-07-20" onChange={vi.fn()} onApplyNormalized={onApply} />,
    );

    const group = screen.getByRole('group', { name: 'Date' });
    expect(group).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /parse text/i }));
    const input = screen.getByPlaceholderText(/circa 44 BC/i);
    fireEvent.change(input, { target: { value: "the summer of '69" } });

    expect(screen.getByText(/1969-06 → 1969-08/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({
      start: '1969-06',
      end: '1969-08',
      approximate: true,
      displayOverride: 'Summer 1969',
    });
  });

  it('wires End date natural-language parser to normalized.end ?? normalized.start', () => {
    const doc = createBlankTimeline('Range');
    doc.events = [
      {
        id: 'evt-r',
        title: 'Cold War',
        date: { start: '1947', end: '1991' },
        media: [],
        tags: [],
      },
    ];
    useEditor.getState().load(doc);

    render(<Inspector />);
    const endGroup = screen.getByRole('group', { name: 'End date' });
    const parseBtn = endGroup.querySelector('button');
    expect(parseBtn).not.toBeNull();
    if (parseBtn) fireEvent.click(parseBtn);
    const nlpInput = endGroup.querySelector('input[placeholder*="circa"]');
    expect(nlpInput).not.toBeNull();
    if (nlpInput) fireEvent.change(nlpInput, { target: { value: '1960s' } });
    const applyBtn = endGroup.querySelector('button.btn-primary');
    expect(applyBtn).not.toBeNull();
    if (applyBtn) fireEvent.click(applyBtn);

    expect(useEditor.getState().doc.events[0]?.date.end).toBe('1969');
  });

  it('defaults candidates to unchecked, warns on unverified citations, validates dates & location opt-in', async () => {
    const api = fakeApi({
      aiExtractText: vi.fn().mockResolvedValue({
        documentTitle: 'Space History',
        sourceText: 'Sputnik 1 launched on Oct 4, 1957.',
        totalChunks: 1,
        processedChunks: 1,
        truncated: false,
        provider: 'mock',
        model: 'mock-model',
        aiGenerated: true,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostMicros: 0 },
        events: [
          {
            id: 'ai-cand-1',
            title: 'Sputnik 1',
            date: { start: '1957-10-04' },
            body: 'First artificial satellite.',
            tags: ['space'],
            location: { lat: 45.9646, lng: 63.3052, label: 'Baikonur' },
            citation: {
              quote: 'Sputnik 1 launched on Oct 4, 1957.',
              startOffset: 0,
              endOffset: 34,
            },
            confidence: 0.95,
            aiGenerated: true,
          },
          {
            id: 'ai-cand-2',
            title: 'Unverified Event',
            date: { start: '1961-04-12' },
            tags: [],
            citation: {
              quote: 'Invented quote not in source',
            },
            confidence: 0.4,
            aiGenerated: true,
          },
        ],
      }),
    });
    useCloud.setState({ api, user: { id: 'u1', email: 'a@b.c', name: 'Alice' }, checking: false });

    const onDone = vi.fn();
    render(
      <Dialog.Root open={true}>
        <AiExtractImport onDone={onDone} />
      </Dialog.Root>,
    );

    const textarea = screen.getByLabelText(/Source text/i);
    fireEvent.change(textarea, { target: { value: '  Sputnik 1 launched on Oct 4, 1957.' } });
    fireEvent.click(screen.getByRole('button', { name: /Extract events/i }));

    await waitFor(() => {
      expect(screen.getAllByText(/AI-suggested/)).toHaveLength(2);
    });

    // All candidates start unchecked (opt-in)
    expect(screen.getByText(/0 of 2 selected for import/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add 0 approved events/i })).toBeDisabled();
    expect(screen.getByText(/Citation quote not matched verbatim in source/)).toBeInTheDocument();
    expect(screen.getByText(/Baikonur/)).toBeInTheDocument();

    // Approve first candidate; verify invalid date disables import
    const approveCheckboxes = screen.getAllByLabelText('Approve');
    fireEvent.click(approveCheckboxes[0]);

    const startInput = screen.getByLabelText('Event 1 start date');
    fireEvent.change(startInput, { target: { value: '1957-13-99' } });
    expect(screen.getByRole('button', { name: /Add 1 approved event/i })).toBeDisabled();

    fireEvent.change(startInput, { target: { value: '1957-10-04' } });
    // Opt into location as well
    fireEvent.click(screen.getByLabelText(/Include suggested location/i));

    fireEvent.click(screen.getByRole('button', { name: /Add 1 approved event/i }));
    expect(useEditor.getState().doc.events).toHaveLength(2);
    expect(useEditor.getState().doc.events[1]?.title).toBe('Sputnik 1');
    expect(useEditor.getState().doc.events[1]?.aiGenerated).toBe(true);
    expect(useEditor.getState().doc.events[1]?.location?.label).toBe('Baikonur');
    expect(onDone).toHaveBeenCalled();
  });

  it('shows AI summary and alt-text suggestions for review and marks provenance when applied', async () => {
    const api = fakeApi({
      aiSummarize: vi.fn().mockResolvedValue({
        summary: 'Concise Apollo 11 summary.',
        originalLength: 60,
        summaryLength: 26,
        provider: 'mock',
        model: 'mock-model',
        aiGenerated: true,
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, estimatedCostMicros: 0 },
      }),
      aiAltText: vi.fn().mockResolvedValue({
        altText: 'Lunar module on the surface of the Moon.',
        confidence: 0.91,
        provider: 'mock',
        model: 'mock-model',
        aiGenerated: true,
        usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, estimatedCostMicros: 0 },
      }),
    });
    useCloud.setState({ api, user: { id: 'u1', email: 'a@b.c', name: 'Alice' }, checking: false });

    render(<Inspector />);

    fireEvent.click(screen.getByRole('button', { name: /Suggest summary/i }));
    await waitFor(() => {
      expect(screen.getByText('Concise Apollo 11 summary.')).toBeInTheDocument();
    });
    expect(useEditor.getState().doc.events[0]?.body).not.toBe('Concise Apollo 11 summary.');

    fireEvent.click(screen.getByRole('button', { name: 'Replace body' }));
    expect(useEditor.getState().doc.events[0]?.body).toBe('Concise Apollo 11 summary.');
    expect(useEditor.getState().doc.events[0]?.aiGenerated).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Suggest alt text/i }));
    await waitFor(() => {
      expect(screen.getByText('Lunar module on the surface of the Moon.')).toBeInTheDocument();
    });
    expect(useEditor.getState().doc.events[0]?.media[0]?.alt).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(useEditor.getState().doc.events[0]?.media[0]?.alt).toBe(
      'Lunar module on the surface of the Moon.',
    );
    expect(useEditor.getState().doc.events[0]?.media[0]?.aiGenerated).toBe(true);
  });

  it('keeps a pending alt-text suggestion with its own image when another image is removed', async () => {
    const doc = useEditor.getState().doc;
    const evt = doc.events[0];
    useEditor.getState().load({
      ...doc,
      events: [
        {
          ...evt,
          media: [
            { type: 'image', url: 'https://example.com/first.jpg', alt: '' },
            { type: 'image', url: 'https://example.com/second.jpg', alt: '' },
          ],
        },
      ],
    });
    const api = fakeApi({
      aiAltText: vi.fn().mockResolvedValue({
        altText: 'Description of the second image.',
        confidence: 0.9,
        provider: 'mock',
        model: 'mock-model',
        aiGenerated: true,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostMicros: 0 },
      }),
    });
    useCloud.setState({ api, user: { id: 'u1', email: 'a@b.c', name: 'Alice' }, checking: false });

    render(<Inspector />);
    const suggest = screen.getAllByRole('button', { name: /Suggest alt text/i });
    fireEvent.click(suggest[1]);
    await waitFor(() => {
      expect(screen.getByText('Description of the second image.')).toBeInTheDocument();
    });

    // Remove the first image: the second moves to index 0 and must keep its suggestion.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(useEditor.getState().doc.events[0]?.media.map((m) => m.url)).toEqual([
      'https://example.com/second.jpg',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(useEditor.getState().doc.events[0]?.media[0]).toMatchObject({
      url: 'https://example.com/second.jpg',
      alt: 'Description of the second image.',
    });
  });

  it('strips heavy media in ConflictsDialog AI checks and preserves results as stale on edits', async () => {
    const aiDetectConflicts = vi.fn().mockResolvedValue({
      conflicts: [
        {
          id: 'ai-conflict:1',
          kind: 'semantic_contradiction',
          severity: 'warning',
          eventIds: ['evt-a'],
          message: 'Claim appears inconsistent.',
          aiGenerated: true,
        },
      ],
      aiGenerated: true,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, estimatedCostMicros: 0 },
    });
    const api = fakeApi({ aiDetectConflicts });
    useCloud.setState({ api, user: { id: 'u1', email: 'a@b.c', name: 'Alice' }, checking: false });

    const doc = createBlankTimeline('Conflicts');
    doc.events = [
      {
        id: 'evt-a',
        title: 'Event A',
        date: { start: '2020-05-01' },
        body: 'x'.repeat(800),
        media: [{ type: 'image', url: 'data:image/png;base64,AAAA' }],
        tags: [],
      },
    ];
    useEditor.getState().load(doc);

    render(<ConflictsDialog open={true} onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Check with AI/i }));

    await waitFor(() => {
      expect(screen.getByText('Claim appears inconsistent.')).toBeInTheDocument();
    });

    const sentPayload = (
      aiDetectConflicts.mock.calls[0]?.[0] as {
        timeline: { events: { media: unknown[]; body?: string }[] };
      }
    ).timeline;
    expect(sentPayload.events[0]?.media).toEqual([]);
    expect(sentPayload.events[0]?.body?.length).toBe(500);

    // Editing the timeline marks AI results stale instead of wiping them
    const nextDoc = { ...doc, title: 'Updated Title' };
    useEditor.getState().load(nextDoc);
    await waitFor(() => {
      expect(
        screen.getByText(/Timeline changed — previous AI results may be stale/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText('Claim appears inconsistent.')).toBeInTheDocument();
  });
});
