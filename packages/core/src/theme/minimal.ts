import type { ThemeTokens } from "../types.js";

export const minimalTheme: ThemeTokens = {
  name: "minimal",
  colors: {
    primary: "#18181b",
    primaryLight: "#f4f4f5",
    secondary: "#71717a",
    background: "#ffffff",
    surface: "#ffffff",
    surfaceAlt: "#fafafa",
    text: "#18181b",
    textSecondary: "#71717a",
    textInverse: "#ffffff",
    border: "#e4e4e7",
    accent: "#52525b",
    error: "#dc2626",
    axisLine: "#e4e4e7",
    marker: "#18181b",
    markerActive: "#000000",
    eraBackground: "rgba(24, 24, 27, 0.04)",
  },
  typography: {
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontFamilyMono:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSizeBase: "14px",
    fontSizeSm: "12px",
    fontSizeLg: "16px",
    fontSizeXl: "18px",
    fontSizeTitle: "22px",
    lineHeight: "1.5",
    fontWeightNormal: "400",
    fontWeightMedium: "500",
    fontWeightBold: "600",
  },
  spacing: {
    xs: "3px",
    sm: "6px",
    md: "12px",
    lg: "20px",
    xl: "28px",
    xxl: "40px",
  },
  borderRadius: {
    sm: "2px",
    md: "4px",
    lg: "6px",
    full: "9999px",
  },
  shadows: {
    sm: "none",
    md: "0 1px 3px 0 rgba(0, 0, 0, 0.05)",
    lg: "0 4px 6px -1px rgba(0, 0, 0, 0.08)",
  },
  transitions: {
    fast: "100ms ease",
    normal: "200ms ease",
    slow: "300ms ease",
  },
  media: {
    maxMediaHeight: "320px",
    thumbnailSize: "72px",
  },
};
