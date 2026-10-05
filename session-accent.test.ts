import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  getSessionAccentHex,
  type SessionAccentInputs,
} from "./session-accent";
import { sessionAccent } from "./extension";

/**
 * `session-accent.ts` mirrors the host CLI's `getSessionAccentHex` (omp
 * 18.4.9, `packages/tui/src/theme/session-color.ts`). The vectors below were
 * generated from the implementation extracted from the compiled binary; the
 * extension entry point is exercised separately for token wiring.
 */

/** `theme.sessionAccentInputs.colorHexes` for the titanium dark theme. */
const TITANIUM_MAJOR = [
  "#00b4ff",
  "#2a3038",
  "#00b4ff",
  "#1f252d",
  "#00ff88",
  "#ff4757",
  "#ffb347",
  "#00b4ff",
  "#00b4ff",
  "#00ff88",
  "#9ca3b0",
  "#2a3038",
  "#00b4ff",
  "#00ff88",
  "#ff4757",
  "#d4c090",
  "#9ca3b0",
];

const LIGHT_THEME_HEXES = ["#0082b3", "#d4c090", "#ff4757"];

const VECTORS: Array<{
  name: string;
  inputs: SessionAccentInputs;
  expected: string;
}> = [
  {
    // The reported regression: CLI purple vs sidebar pink (#ff3d85).
    name: "Resume previous training session",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: TITANIUM_MAJOR,
      surfaceLuminance: undefined,
    },
    expected: "#8378ff",
  },
  {
    name: "Resume previous training session",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: TITANIUM_MAJOR,
      surfaceLuminance: 0.95,
    },
    expected: "#0088ff",
  },
  {
    name: "Resume previous training session",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: TITANIUM_MAJOR,
      surfaceLuminance: 0.55,
    },
    expected: "#006bcc",
  },
  {
    name: "gallery",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: ["#00b4ff", "#2a3038"],
      surfaceLuminance: undefined,
    },
    expected: "#00c7ff",
  },
  {
    name: "Build 1M pools with top-k guesses",
    inputs: {
      accentHex: "#d4c090",
      colorHexes: ["#d4c090", "#00ff88", "#ff4757"],
      surfaceLuminance: undefined,
    },
    expected: "#c1748f",
  },
  {
    name: "Debugging sidebar session issues",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: [],
      surfaceLuminance: undefined,
    },
    expected: "#e655bc",
  },
  {
    name: "warm",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: ["#ff0000", "#00ff00"],
      surfaceLuminance: undefined,
    },
    expected: "#00c6ff",
  },
  {
    name: "light-theme",
    inputs: {
      accentHex: "#0082b3",
      colorHexes: LIGHT_THEME_HEXES,
      surfaceLuminance: 0.9,
    },
    expected: "#4e13ac",
  },
  {
    name: "light-mid",
    inputs: {
      accentHex: "#0082b3",
      colorHexes: ["#0082b3"],
      surfaceLuminance: 0.55,
    },
    expected: "#811dab",
  },
  {
    name: "light-95",
    inputs: {
      accentHex: "#0082b3",
      colorHexes: ["#0082b3", "#ff4757"],
      surfaceLuminance: 0.95,
    },
    expected: "#781aab",
  },
  {
    name: "no-accent",
    inputs: {
      accentHex: "#zzz",
      colorHexes: ["#00b4ff"],
      surfaceLuminance: undefined,
    },
    expected: "#e4724b",
  },
  {
    name: "black-accent",
    inputs: {
      accentHex: "#000000",
      colorHexes: ["#00b4ff"],
      surfaceLuminance: undefined,
    },
    expected: "#bb5ee8",
  },
  {
    name: "white-accent",
    inputs: {
      accentHex: "#ffffff",
      colorHexes: [],
      surfaceLuminance: undefined,
    },
    expected: "#6dd3ed",
  },
  {
    name: "unicodé 🚀",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: ["#00b4ff"],
      surfaceLuminance: undefined,
    },
    expected: "#9370ff",
  },
  {
    name: "crowded",
    inputs: {
      accentHex: "#00b4ff",
      colorHexes: [
        "#ff0000",
        "#ff8000",
        "#ffff00",
        "#80ff00",
        "#00ff00",
        "#00ff80",
        "#00ffff",
        "#0080ff",
        "#0000ff",
        "#8000ff",
        "#ff00ff",
        "#ff0080",
      ],
      surfaceLuminance: undefined,
    },
    expected: "#00ecff",
  },
];

describe("getSessionAccentHex golden vectors (omp 18.4.9)", () => {
  for (const vector of VECTORS) {
    test(`${JSON.stringify(vector.name)} → ${vector.expected}`, () => {
      expect(getSessionAccentHex(vector.name, vector.inputs)).toBe(
        vector.expected,
      );
    });
  }

  test("is deterministic for identical inputs", () => {
    for (const vector of VECTORS) {
      const clone: SessionAccentInputs = {
        accentHex: vector.inputs.accentHex,
        colorHexes: [...vector.inputs.colorHexes],
        surfaceLuminance: vector.inputs.surfaceLuminance,
      };
      expect(getSessionAccentHex(vector.name, clone)).toBe(vector.expected);
    }
  });

  test("keeps AA-large contrast on light surfaces", () => {
    for (const vector of VECTORS) {
      const surfaceLuminance = vector.inputs.surfaceLuminance;
      if (surfaceLuminance === undefined) continue;
      expect(
        contrastRatio(vector.expected, surfaceLuminance),
      ).toBeGreaterThanOrEqual(2.99);
    }
  });
});

describe("sessionAccent host wiring", () => {
  const name = "Resume previous training session";
  const tokenInputs: SessionAccentInputs = {
    accentHex: "#00b4ff",
    colorHexes: TITANIUM_MAJOR,
    surfaceLuminance: undefined,
  };

  test("uses the frozen theme.sessionAccentInputs token", () => {
    const theme = { sessionAccentInputs: tokenInputs };
    expect(sessionAccent(contextWithTheme(name, theme))).toBe(
      getSessionAccentHex(name, tokenInputs),
    );
  });

  test("unnamed sessions have no accent", () => {
    const theme = { sessionAccentInputs: tokenInputs };
    expect(sessionAccent(contextWithTheme("", theme))).toBeNull();
    expect(sessionAccent(contextWithTheme("   ", theme))).toBeNull();
  });

  test("hosts without the token stay neutral instead of guessing", () => {
    expect(sessionAccent(contextWithTheme(name, {}))).toBeNull();
    expect(sessionAccent(contextWithTheme(name, { isLight: true }))).toBeNull();
    expect(
      sessionAccent(
        contextWithTheme(name, {
          getAccentColorHex: () => "#00b4ff",
          getMajorThemeColorHexes: () => LIGHT_THEME_HEXES,
          accentSurfaceLuminance: 0.9,
        }),
      ),
    ).toBeNull();
  });

  test("malformed tokens are rejected, not approximated", () => {
    expect(
      sessionAccent(
        contextWithTheme(name, {
          sessionAccentInputs: { accentHex: 42, colorHexes: "nope" },
        }),
      ),
    ).toBeNull();
    expect(
      sessionAccent(contextWithTheme(name, { sessionAccentInputs: null })),
    ).toBeNull();
  });

  test("token read failures degrade to neutral", () => {
    const throwing = {
      get sessionAccentInputs(): unknown {
        throw new Error("token unavailable");
      },
    };
    expect(sessionAccent(contextWithTheme(name, throwing))).toBeNull();
  });
});

function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const linear = (channel: number) => {
    const scaled = channel / 255;
    return scaled <= 0.04045
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linear((value >> 16) & 0xff) +
    0.7152 * linear((value >> 8) & 0xff) +
    0.0722 * linear(value & 0xff)
  );
}

function contrastRatio(accent: string, surfaceLuminance: number): number {
  const luminance = relativeLuminance(accent);
  return (
    (Math.max(luminance, surfaceLuminance) + 0.05) /
    (Math.min(luminance, surfaceLuminance) + 0.05)
  );
}

function contextWithTheme(name: string, theme: unknown): ExtensionContext {
  return {
    ui: { theme },
    sessionManager: { getSessionName: () => name },
  } as unknown as ExtensionContext;
}
