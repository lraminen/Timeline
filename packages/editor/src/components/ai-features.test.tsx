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
  it('parses natural-language dates locally and applies only after explicit user click', () => {
    const onApply = vi.fn();
    render(
      <DateField
        legend="Date"
        value="1969-07-20"
        onChange={vi.fn()}
        onApplyNormalized={onApply}
      />,
    );

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

  it('requires review and explicit approval before adding AI-extracted events', async () => {
    const api = fakeApi({
      aiExtractText: vi.fn().mockResolvedValue({
        documentTitle: 'Space History',
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
            citation: { quote: 'Sputnik 1 launched on Oct 4, 1957.', startOffset: 0, endOffset: 34 },
            confidence: 0.95,
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
    fireEvent.change(textarea, { target: { value: 'Sputnik 1 launched on Oct 4, 1957.' } });
    fireEvent.click(screen.getByRole('button', { name: /Extract events/i }));

    await waitFor(() => {
      expect(screen.getByText(/AI-suggested/)).toBeInTheDocument();
    });

    // Event is NOT yet added to store until human approves
    expect(useEditor.getState().doc.events).toHaveLength(1);
    expect(screen.getByText(/95% confidence/)).toBeInTheDocument();
    expect(screen.getByText(/Sputnik 1 launched on Oct 4, 1957\./)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Add 1 approved event/i }));
    expect(useEditor.getState().doc.events).toHaveLength(2);
    expect(useEditor.getState().doc.events[1]?.title).toBe('Sputnik 1');
    expect(onDone).toHaveBeenCalled();
  });

  it('shows AI summary and alt-text suggestions for review before applying', async () => {
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
    // Not applied yet!
    expect(useEditor.getState().doc.events[0]?.body).not.toBe('Concise Apollo 11 summary.');

    fireEvent.click(screen.getByRole('button', { name: 'Replace body' }));
    expect(useEditor.getState().doc.events[0]?.body).toBe('Concise Apollo 11 summary.');

    fireEvent.click(screen.getByRole('button', { name: /Suggest alt text/i }));
    await waitFor(() => {
      expect(screen.getByText('Lunar module on the surface of the Moon.')).toBeInTheDocument();
    });
    expect(useEditor.getState().doc.events[0]?.media[0]?.alt).toBe('');

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(useEditor.getState().doc.events[0]?.media[0]?.alt).toBe(
      'Lunar module on the surface of the Moon.',
    );
  });

  it('surfaces deterministic timeline conflicts in ConflictsDialog', () => {
    const doc = createBlankTimeline('Conflicts');
    doc.events = [
      {
        id: 'bad-range',
        title: 'Broken Event',
        date: { start: '2020-05-01', end: '2020-01-01' },
        media: [],
        tags: [],
      },
    ];
    useEditor.getState().load(doc);

    render(<ConflictsDialog open={true} onOpenChange={vi.fn()} />);
    expect(screen.getByText(/Broken Event/)).toBeInTheDocument();
    expect(screen.getByText(/Rule check/)).toBeInTheDocument();
  });
});
