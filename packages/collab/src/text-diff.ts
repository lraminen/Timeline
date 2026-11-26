/**
 * The smallest single splice that turns `from` into `to`: keep the common
 * prefix and suffix, replace what lies between.
 *
 * Indices are UTF-16 code units (what Y.Text uses). Boundaries never split a
 * surrogate pair, so concurrent edits next to an emoji cannot merge into a
 * lone surrogate.
 */
export interface Splice {
  index: number;
  remove: number;
  insert: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function diffText(from: string, to: string): Splice | null {
  if (from === to) return null;
  const max = Math.min(from.length, to.length);

  let prefix = 0;
  while (prefix < max && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix++;
  // Don't end the prefix between the two halves of a surrogate pair.
  if (prefix > 0 && isHighSurrogate(from.charCodeAt(prefix - 1))) prefix--;

  let suffix = 0;
  const maxSuffix = max - prefix;
  while (
    suffix < maxSuffix &&
    from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)
  ) {
    suffix++;
  }
  // Don't start the suffix on the low half of a surrogate pair.
  if (suffix > 0 && isLowSurrogate(from.charCodeAt(from.length - suffix))) suffix--;

  return {
    index: prefix,
    remove: from.length - prefix - suffix,
    insert: to.slice(prefix, to.length - suffix),
  };
}
