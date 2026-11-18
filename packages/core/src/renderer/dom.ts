/**
 * Lightweight DOM element factory.
 */
export function h(
  tag: string,
  attrs: Record<string, string | number | boolean | undefined | null> = {},
  ...children: (Node | string | number | boolean | null | undefined)[]
): HTMLElement {
  const el = document.createElement(tag);

  setAttributes(el, attrs);

  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (child instanceof Node) {
      el.appendChild(child);
    } else {
      el.appendChild(document.createTextNode(String(child)));
    }
  }

  return el;
}

/**
 * Safely sets attributes on an HTMLElement.
 */
export function setAttributes(
  el: HTMLElement,
  attrs: Record<string, string | number | boolean | undefined | null>,
): void {
  for (const [key, val] of Object.entries(attrs)) {
    if (val === undefined || val === null || val === false) {
      el.removeAttribute(key);
    } else if (val === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(val));
    }
  }
}

/**
 * Clears all child nodes from an HTMLElement.
 */
export function clearChildren(el: HTMLElement): void {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/**
 * Creates a CSSStyleSheet or fallback style element.
 */
export function createStyleSheet(css: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  return sheet;
}
