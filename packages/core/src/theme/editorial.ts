import type { ThemeTokens } from "../types.js";

export const editorialTheme: ThemeTokens = {
  name: "editorial",
  colors: {
    primary: "#881337",
    primaryLight: "#ffe4e6",
    secondary: "#4c0519",
    background: "#faf8f5",
    surface: "#ffffff",
    surfaceAlt: "#f5f0eb",
    text: "#1c1917",
    textSecondary: "#78716c",
    textInverse: "#faf8f5",
    border: "#e7e5e4",
    accent: "#b45309",
    error: "#b91c1c",
    axisLine: "#d6d3d1",
    marker: "#881337",
    markerActive: "#4c0519",
    eraBackground: "rgba(136, 19, 55, 0.05)",
  },
  typography: {
    fontFamily:
      'Georgia, Cambria, "Times New Roman", Times, serif',
    fontFamilyMono:
      '"Courier New", Courier, monospace',
    fontSizeBase: "16px",
    fontSizeSm: "14px",
    fontSizeLg: "18px",
    fontSizeXl: "22px",
    fontSizeTitle: "28px",
    lineHeight: "1.7",
    fontWeightNormal: "400",
    fontWeightMedium: "600",
    fontWeightBold: "700",
  },
  spacing: {
    xs: "4px",
    sm: "8px",
    md: "16px",
    lg: "24px",
    xl: "36px",
    xxl: "56px",
  },
  borderRadius: {
    sm: "2px",
    md: "4px",
    lg: "8px",
    full: "9999px",
  },
  shadows: {
    sm: "0 1px 2px 0 rgba(28, 25, 23, 0.05)",
    md: "0 4px 6px -1px rgba(28, 25, 23, 0.08), 0 2px 4px -2px rgba(28, 25, 23, 0.05)",
    lg: "0 10px 15px -3px rgba(28, 25, 23, 0.1), 0 4px 6px -4px rgba(28, 25, 23, 0.05)",
  },
  transitions: {
    fast: "150ms ease-in-out",
    normal: "300ms ease-in-out",
    slow: "500ms ease-in-out",
  },
  media: {
    maxMediaHeight: "400px",
    thumbnailSize: "88px",
  },
};
