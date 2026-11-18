import type { ThemeTokens } from "../types.js";

export const darkTheme: ThemeTokens = {
  name: "dark",
  colors: {
    primary: "#3b82f6",
    primaryLight: "#1e3a8a",
    secondary: "#94a3b8",
    background: "#0f172a",
    surface: "#1e293b",
    surfaceAlt: "#334155",
    text: "#f8fafc",
    textSecondary: "#94a3b8",
    textInverse: "#0f172a",
    border: "#334155",
    accent: "#fbbf24",
    error: "#f87171",
    axisLine: "#475569",
    marker: "#3b82f6",
    markerActive: "#60a5fa",
    eraBackground: "rgba(59, 130, 246, 0.12)",
  },
  typography: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    fontFamilyMono:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSizeBase: "15px",
    fontSizeSm: "13px",
    fontSizeLg: "17px",
    fontSizeXl: "20px",
    fontSizeTitle: "24px",
    lineHeight: "1.6",
    fontWeightNormal: "400",
    fontWeightMedium: "500",
    fontWeightBold: "600",
  },
  spacing: {
    xs: "4px",
    sm: "8px",
    md: "16px",
    lg: "24px",
    xl: "32px",
    xxl: "48px",
  },
  borderRadius: {
    sm: "4px",
    md: "8px",
    lg: "12px",
    full: "9999px",
  },
  shadows: {
    sm: "0 1px 2px 0 rgba(0, 0, 0, 0.3)",
    md: "0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 2px 4px -2px rgba(0, 0, 0, 0.4)",
    lg: "0 10px 15px -3px rgba(0, 0, 0, 0.5), 0 4px 6px -4px rgba(0, 0, 0, 0.5)",
  },
  transitions: {
    fast: "150ms ease-in-out",
    normal: "250ms ease-in-out",
    slow: "400ms ease-in-out",
  },
  media: {
    maxMediaHeight: "360px",
    thumbnailSize: "80px",
  },
};
