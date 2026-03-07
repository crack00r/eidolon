/**
 * Tests for theme design tokens -- validates structural integrity
 * of the shared design system constants.
 */

import { describe, expect, test } from "bun:test";
import {
  animation,
  breakpoints,
  colors,
  layout,
  memoryTypeColors,
  radius,
  safetyColors,
  shadows,
  spacing,
  statusColors,
  typography,
} from "./theme";

describe("theme tokens", () => {
  describe("colors", () => {
    test("dark and light themes have identical keys", () => {
      const darkKeys = Object.keys(colors.dark).sort();
      const lightKeys = Object.keys(colors.light).sort();
      expect(darkKeys).toEqual(lightKeys);
    });

    test("all color values are valid hex strings", () => {
      const hexRe = /^#[0-9a-fA-F]{6}$/;
      for (const [key, value] of Object.entries(colors.dark)) {
        expect(hexRe.test(value)).toBe(true);
      }
      for (const [key, value] of Object.entries(colors.light)) {
        expect(hexRe.test(value)).toBe(true);
      }
    });

    test("has required semantic color keys", () => {
      const required = ["bgPrimary", "bgSecondary", "textPrimary", "accent", "success", "warning", "error"];
      for (const key of required) {
        expect(key in colors.dark).toBe(true);
        expect(key in colors.light).toBe(true);
      }
    });
  });

  describe("statusColors", () => {
    test("has all cognitive states", () => {
      const states = ["idle", "perceiving", "evaluating", "acting", "reflecting", "dreaming"];
      for (const state of states) {
        expect(state in statusColors).toBe(true);
      }
    });

    test("has connection states", () => {
      const states = ["connected", "disconnected", "connecting", "authenticating", "error"];
      for (const state of states) {
        expect(state in statusColors).toBe(true);
      }
    });
  });

  describe("memoryTypeColors", () => {
    test("has all memory types", () => {
      const types = ["episodic", "semantic", "procedural", "working", "meta"];
      for (const t of types) {
        expect(t in memoryTypeColors).toBe(true);
      }
    });
  });

  describe("safetyColors", () => {
    test("has safe, review, unsafe", () => {
      expect(safetyColors.safe).toBeDefined();
      expect(safetyColors.review).toBeDefined();
      expect(safetyColors.unsafe).toBeDefined();
    });
  });

  describe("typography", () => {
    test("has font families", () => {
      expect(typography.fontFamily.mono).toContain("monospace");
      expect(typography.fontFamily.sans).toContain("sans-serif");
    });

    test("font sizes are valid px strings", () => {
      for (const value of Object.values(typography.fontSize)) {
        expect(value).toMatch(/^\d+px$/);
      }
    });
  });

  describe("spacing", () => {
    test("has a 0 value", () => {
      expect(spacing[0]).toBe("0");
    });

    test("all non-zero values are px strings", () => {
      for (const [key, value] of Object.entries(spacing)) {
        if (key !== "0") {
          expect(value).toMatch(/^\d+px$/);
        }
      }
    });
  });

  describe("layout", () => {
    test("has sidebar and header dimensions", () => {
      expect(layout.sidebarWidth).toBeDefined();
      expect(layout.headerHeight).toBeDefined();
      expect(layout.maxContentWidth).toBeDefined();
    });
  });

  describe("animation", () => {
    test("has timing values in seconds", () => {
      expect(animation.fast).toMatch(/^\d+\.?\d*s$/);
      expect(animation.normal).toMatch(/^\d+\.?\d*s$/);
      expect(animation.slow).toMatch(/^\d+\.?\d*s$/);
    });

    test("fast < normal < slow", () => {
      const fast = parseFloat(animation.fast);
      const normal = parseFloat(animation.normal);
      const slow = parseFloat(animation.slow);
      expect(fast).toBeLessThan(normal);
      expect(normal).toBeLessThan(slow);
    });
  });

  describe("breakpoints", () => {
    test("are in ascending order", () => {
      const values = [
        parseInt(breakpoints.sm),
        parseInt(breakpoints.md),
        parseInt(breakpoints.lg),
        parseInt(breakpoints.xl),
      ];
      for (let i = 1; i < values.length; i++) {
        expect(values[i]!).toBeGreaterThan(values[i - 1]!);
      }
    });
  });
});
