/**
 * Shared design tokens for the Eidolon UI.
 *
 * These TypeScript constants serve as the single source of truth for the
 * design system across web and desktop (Svelte) clients. The iOS app mirrors
 * these values in `EidolonColors` (ContentView.swift).
 *
 * CSS custom properties in app.css derive from these tokens.  When adding a
 * new token here, update app.css `:root` and the iOS `EidolonColors` enum to
 * keep all three platforms in sync.
 */

// ---------------------------------------------------------------------------
// Color Palette
// ---------------------------------------------------------------------------

export const colors = {
  dark: {
    bgPrimary: "#1a1a2e",
    bgSecondary: "#16213e",
    bgTertiary: "#0f3460",
    textPrimary: "#e6e6e6",
    textSecondary: "#a0a0a0",
    accent: "#e94560",
    accentHover: "#ff6b81",
    success: "#2ecc71",
    warning: "#f39c12",
    error: "#e74c3c",
    border: "#2a2a4a",
    info: "#3498db",
    purple: "#9b59b6",
  },
  light: {
    bgPrimary: "#f5f5f7",
    bgSecondary: "#ffffff",
    bgTertiary: "#e8e8ed",
    textPrimary: "#1a1a2e",
    textSecondary: "#6b6b7b",
    accent: "#e94560",
    accentHover: "#d63851",
    success: "#27ae60",
    warning: "#e67e22",
    error: "#c0392b",
    border: "#d1d1d6",
    info: "#2980b9",
    purple: "#8e44ad",
  },
} as const;

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const typography = {
  fontFamily: {
    mono: '"SF Mono", "Fira Code", "JetBrains Mono", ui-monospace, "Cascadia Mono", "Segoe UI Mono", "Liberation Mono", Menlo, Monaco, Consolas, monospace',
    sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  fontSize: {
    xs: "11px",
    sm: "12px",
    base: "14px",
    md: "16px",
    lg: "18px",
    xl: "20px",
    "2xl": "24px",
    "3xl": "30px",
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: 1.25,
    normal: 1.5,
    relaxed: 1.6,
  },
} as const;

// ---------------------------------------------------------------------------
// Spacing Scale (4px base)
// ---------------------------------------------------------------------------

export const spacing = {
  0: "0",
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  10: "40px",
  12: "48px",
  16: "64px",
} as const;

// ---------------------------------------------------------------------------
// Border Radius
// ---------------------------------------------------------------------------

export const radius = {
  sm: "4px",
  md: "6px",
  lg: "8px",
  xl: "12px",
  full: "9999px",
} as const;

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

export const shadows = {
  sm: "0 1px 2px rgba(0, 0, 0, 0.3)",
  md: "0 2px 4px rgba(0, 0, 0, 0.3)",
  lg: "0 4px 8px rgba(0, 0, 0, 0.4)",
  xl: "0 8px 16px rgba(0, 0, 0, 0.4)",
} as const;

// ---------------------------------------------------------------------------
// Status Colors (semantic, matching cognitive loop states)
// ---------------------------------------------------------------------------

export const statusColors = {
  idle: "#a0a0a0",
  perceiving: "#3498db",
  evaluating: "#f39c12",
  acting: "#2ecc71",
  reflecting: "#9b59b6",
  dreaming: "#e94560",
  connected: "#2ecc71",
  disconnected: "#a0a0a0",
  connecting: "#f39c12",
  authenticating: "#3498db",
  error: "#e74c3c",
} as const;

// ---------------------------------------------------------------------------
// Memory Type Colors
// ---------------------------------------------------------------------------

export const memoryTypeColors = {
  episodic: "#e94560",
  semantic: "#2ecc71",
  procedural: "#f39c12",
  working: "#3498db",
  meta: "#9b59b6",
  fact: "#2ecc71",
  preference: "#e94560",
  decision: "#f39c12",
  skill: "#3498db",
  relationship: "#9b59b6",
  schema: "#e67e22",
} as const;

// ---------------------------------------------------------------------------
// Safety Classification Colors
// ---------------------------------------------------------------------------

export const safetyColors = {
  safe: "#2ecc71",
  review: "#f39c12",
  unsafe: "#e74c3c",
} as const;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const layout = {
  sidebarWidth: "220px",
  maxContentWidth: "1200px",
  headerHeight: "48px",
  inputMinHeight: "38px",
  inputMaxHeight: "120px",
  detailPanelWidth: "360px",
} as const;

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

export const animation = {
  fast: "0.1s",
  normal: "0.15s",
  slow: "0.3s",
} as const;

// ---------------------------------------------------------------------------
// Breakpoints (for responsive layout)
// ---------------------------------------------------------------------------

export const breakpoints = {
  sm: "640px",
  md: "768px",
  lg: "1024px",
  xl: "1280px",
} as const;
