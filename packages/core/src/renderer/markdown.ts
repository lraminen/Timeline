import { parseMarkdown, isSafeHref, type MdNode } from '../markdown.js';

export { isSafeHref };

function toDom(node: MdNode): Node {
  if (node.type === 'text') return document.createTextNode(node.value);
  const element = document.createElement(node.tag);
  for (const [k, v] of Object.entries(node.attrs ?? {})) element.setAttribute(k, v);
  for (const child of node.children) element.appendChild(toDom(child));
  return element;
}

/**
 * Renders Chronicle's Markdown subset into DOM nodes. Built with
 * `createElement`/text nodes only — never `innerHTML` — from the shared
 * parser in `../markdown.ts`, which defines the supported syntax and the
 * link-safety rules.
 */
export function renderMarkdown(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const node of parseMarkdown(source)) frag.appendChild(toDom(node));
  return frag;
}
