import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor as useTiptap, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import * as Popover from '@radix-ui/react-popover';
import { Bold, Code, Italic, Link2, List, ListOrdered, Quote, Unlink } from 'lucide-react';
import { isSafeHref } from '@chronicle/core';

function getMarkdown(editor: Editor): string {
  const storage = editor.storage as { markdown: { getMarkdown(): string } };
  return storage.markdown.getMarkdown();
}

/**
 * Markdown rich-text editor. Features are limited to what Chronicle's
 * renderer displays (bold, italic, code, links, lists, quotes) so the editing
 * experience matches the published timeline.
 *
 * Tiptap's own history is disabled: undo/redo go through the editor-wide
 * command history so one Ctrl+Z behaves the same everywhere.
 */
export function RichTextEditor({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (markdown: string) => void;
  label: string;
}) {
  const lastEmitted = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useTiptap({
    extensions: [
      StarterKit.configure({
        history: false,
        heading: false,
        codeBlock: false,
        horizontalRule: false,
        strike: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        isAllowedUri: (href) => isSafeHref(href),
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      Placeholder.configure({ placeholder: 'Describe what happened…' }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: false,
        breaks: false,
        transformPastedText: true,
      }),
    ],
    content: value,
    immediatelyRender: true,
    editorProps: {
      attributes: {
        'aria-label': label,
        'aria-multiline': 'true',
        role: 'textbox',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const md = getMarkdown(ed);
      lastEmitted.current = md;
      onChangeRef.current(md);
    },
  });

  // Follow external changes (undo/redo, import, a collaborator's edit)
  // without clobbering typing: the cursor stays where it was.
  useEffect(() => {
    if (value !== lastEmitted.current) {
      lastEmitted.current = value;
      const { from, to } = editor.state.selection;
      const focused = editor.isFocused;
      editor.commands.setContent(value, false);
      if (focused) {
        const max = editor.state.doc.content.size;
        editor.commands.setTextSelection({ from: Math.min(from, max), to: Math.min(to, max) });
      }
    }
  }, [value, editor]);

  const btn = (active: boolean) => `icon-btn h-7 w-7 ${active ? 'bg-blue-100 text-blue-800' : ''}`;

  return (
    <div className="rounded-md border border-slate-300 bg-white focus-within:border-blue-600 focus-within:ring-2 focus-within:ring-blue-600/30">
      <div
        role="toolbar"
        aria-label={`${label} formatting`}
        className="flex flex-wrap gap-0.5 border-b border-slate-200 p-1"
      >
        <button
          type="button"
          className={btn(editor.isActive('bold'))}
          aria-label="Bold"
          aria-pressed={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={btn(editor.isActive('italic'))}
          aria-label="Italic"
          aria-pressed={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={btn(editor.isActive('code'))}
          aria-label="Code"
          aria-pressed={editor.isActive('code')}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code size={15} aria-hidden />
        </button>
        <LinkButton editor={editor} />
        <span className="mx-0.5 w-px bg-slate-200" aria-hidden />
        <button
          type="button"
          className={btn(editor.isActive('bulletList'))}
          aria-label="Bulleted list"
          aria-pressed={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={btn(editor.isActive('orderedList'))}
          aria-label="Numbered list"
          aria-pressed={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered size={15} aria-hidden />
        </button>
        <button
          type="button"
          className={btn(editor.isActive('blockquote'))}
          aria-label="Quote"
          aria-pressed={editor.isActive('blockquote')}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote size={15} aria-hidden />
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function LinkButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');
  const active = editor.isActive('link');
  const valid = href.trim() === '' || isSafeHref(href.trim());

  const apply = () => {
    const url = href.trim();
    if (!url) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else if (isSafeHref(url)) {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    } else {
      return;
    }
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        if (o) setHref((editor.getAttributes('link') as { href?: string }).href ?? 'https://');
        setOpen(o);
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`icon-btn h-7 w-7 ${active ? 'bg-blue-100 text-blue-800' : ''}`}
          aria-label="Link"
          aria-pressed={active}
        >
          <Link2 size={15} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          className="z-50 w-72 rounded-md border border-slate-200 bg-white p-3 shadow-lg"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
            className="space-y-2"
          >
            <label className="label" htmlFor="rte-link-url">
              Link address
            </label>
            <input
              id="rte-link-url"
              className="input"
              value={href}
              aria-invalid={!valid}
              onChange={(e) => {
                setHref(e.target.value);
              }}
              autoFocus
            />
            {!valid && (
              <p className="text-xs text-red-700">Use an http(s), mailto or relative link.</p>
            )}
            <div className="flex justify-end gap-2">
              {active && (
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  onClick={() => {
                    editor.chain().focus().extendMarkRange('link').unsetLink().run();
                    setOpen(false);
                  }}
                >
                  <Unlink size={14} aria-hidden /> Remove
                </button>
              )}
              <button type="submit" className="btn-primary text-xs" disabled={!valid}>
                Apply
              </button>
            </div>
          </form>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
