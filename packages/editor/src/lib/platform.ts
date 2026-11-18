/** True on Apple platforms (for showing ⌘ vs Ctrl in shortcut hints). */
export function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}

export const MOD_KEY = isApplePlatform() ? '⌘' : 'Ctrl+';
