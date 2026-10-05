/**
 * Exact replica of the host CLI's session-accent algorithm.
 *
 * omp 18.4.9 paints the session name and editor border from the frozen
 * `theme.sessionAccentInputs` token via `getSessionAccentHex` in
 * `packages/tui/src/theme/session-color.ts` (OKLCH hue bands + gamut mapping).
 * A `-e` extension cannot value-import that internal module from the compiled
 * binary, so the algorithm is mirrored here bit-for-bit; the extension entry
 * point feeds it the token exposed on `ctx.ui.theme`. When the host exposes no
 * token, callers fall back to the neutral client default (#808080) instead of
 * a guessed hue.
 */

export type SessionAccentInputs = {
  accentHex: string | undefined;
  colorHexes: string[];
  surfaceLuminance: number | undefined;
};

type Rgb = { r: number; g: number; b: number };
type Oklch = { l: number; c: number; h: number };

/** djb2-xor over UTF-16 code units; identical in both host generations. */
function sessionNameHash(name: string): number {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = ((hash << 5) + hash) ^ name.charCodeAt(index);
    hash = hash >>> 0;
  }
  return hash;
}

/** Host `hexToRgb`/`Fk`: `#rgb` or `#rrggbb`; other shapes yield NaN channels. */
function parseHexColor(hex: string): Rgb {
  const value = hex.startsWith("#") ? hex.slice(1) : hex;
  if (value.length === 3) {
    return {
      r: Number.parseInt(value[0] + value[0], 16),
      g: Number.parseInt(value[1] + value[1], 16),
      b: Number.parseInt(value[2] + value[2], 16),
    };
  }
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

function formatHexColor(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

function linearizeChannel(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function gammaEncodeChannel(channel: number): number {
  const value =
    channel <= 0.0031308
      ? channel * 12.92
      : 1.055 * channel ** (1 / 2.4) - 0.055;
  return value * 255;
}

function linearRgbToOklab(
  r: number,
  g: number,
  b: number,
): { l: number; a: number; b: number } {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

function oklabToLinearRgb(l: number, a: number, b: number): Rgb {
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    g: -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    b: -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  };
}

function oklchFromHex(hex: string): Oklch {
  const rgb = parseHexColor(hex);
  const lab = linearRgbToOklab(
    linearizeChannel(rgb.r),
    linearizeChannel(rgb.g),
    linearizeChannel(rgb.b),
  );
  let hue = (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return { l: lab.l, c: Math.hypot(lab.a, lab.b), h: hue };
}

/** Host `sIi`: analytic estimate of the maximum in-gamut chroma for a hue. */
function maxChromaForHue(a: number, b: number): number {
  let c0: number;
  let c1: number;
  let c2: number;
  let c3: number;
  let c4: number;
  let r0: number;
  let r1: number;
  let r2: number;
  if (-1.88170328 * a - 0.80936493 * b > 1) {
    c0 = 1.19086277;
    c1 = 1.76576728;
    c2 = 0.59662641;
    c3 = 0.75515197;
    c4 = 0.56771245;
    r0 = 4.0767416621;
    r1 = -3.3077115913;
    r2 = 0.2309699292;
  } else if (1.81444104 * a - 1.19445276 * b > 1) {
    c0 = 0.73956515;
    c1 = -0.45954404;
    c2 = 0.08285427;
    c3 = 0.1254107;
    c4 = 0.14503204;
    r0 = -1.2684380046;
    r1 = 2.6097574011;
    r2 = -0.3413193965;
  } else {
    c0 = 1.35733652;
    c1 = -0.00915799;
    c2 = -1.1513021;
    c3 = -0.50559606;
    c4 = 0.00692167;
    r0 = -0.0041960863;
    r1 = -0.7034186147;
    r2 = 1.707614701;
  }
  const estimate = c0 + c1 * a + c2 * b + c3 * a * a + c4 * a * b;
  const p = 0.3963377774 * a + 0.2158037573 * b;
  const d = -0.1055613458 * a - 0.0638541728 * b;
  const f = -0.0894841775 * a - 1.291485548 * b;
  const g = 1 + estimate * p;
  const m = 1 + estimate * d;
  const h = 1 + estimate * f;
  const y = r0 * g ** 3 + r1 * m ** 3 + r2 * h ** 3;
  const w = r0 * 3 * p * g * g + r1 * 3 * d * m * m + r2 * 3 * f * h * h;
  const t = r0 * 6 * p * p * g + r1 * 6 * d * d * m + r2 * 6 * f * f * h;
  return estimate - (y * w) / (w * w - 0.5 * y * t);
}

/** Host `UWe`: most vivid in-gamut OKLCH color for a hue (max channel = 1). */
function vividOklchForHue(hue: number): { l: number; c: number } {
  const radians = (hue * Math.PI) / 180;
  const a = Math.cos(radians);
  const b = Math.sin(radians);
  const chroma = maxChromaForHue(a, b);
  const linear = oklabToLinearRgb(1, chroma * a, chroma * b);
  const lightness = Math.cbrt(1 / Math.max(linear.r, linear.g, linear.b));
  return { l: lightness, c: lightness * chroma };
}

const V18_GAMUT_EPSILON = 0.0001;

/** Host `zme`: OKLCH → hex with chroma reduced until sRGB gamut is reached. */
function oklchToHex(oklch: Oklch): string {
  const lightness = Math.max(0, Math.min(1, oklch.l));
  const radians = (oklch.h * Math.PI) / 180;
  const a = Math.cos(radians);
  const b = Math.sin(radians);
  const toLinear = (chroma: number) =>
    oklabToLinearRgb(lightness, chroma * a, chroma * b);
  const inGamut = (rgb: Rgb) =>
    rgb.r >= -V18_GAMUT_EPSILON &&
    rgb.r <= 1 + V18_GAMUT_EPSILON &&
    rgb.g >= -V18_GAMUT_EPSILON &&
    rgb.g <= 1 + V18_GAMUT_EPSILON &&
    rgb.b >= -V18_GAMUT_EPSILON &&
    rgb.b <= 1 + V18_GAMUT_EPSILON;
  let linear = toLinear(oklch.c);
  if (!inGamut(linear)) {
    let lo = 0;
    let hi = oklch.c;
    for (let index = 0; index < 20; index += 1) {
      const mid = (lo + hi) / 2;
      if (inGamut(toLinear(mid))) lo = mid;
      else hi = mid;
    }
    linear = toLinear(lo);
  }
  return formatHexColor({
    r: Math.max(0, Math.min(255, gammaEncodeChannel(linear.r))),
    g: Math.max(0, Math.min(255, gammaEncodeChannel(linear.g))),
    b: Math.max(0, Math.min(255, gammaEncodeChannel(linear.b))),
  });
}

/**
 * Host `Ume`/`relativeLuminance`: WCAG 2.x relative luminance for
 * `#rgb`/`#rrggbb`; `undefined` for unparseable values.
 */
function hexRelativeLuminance(hex: string): number | undefined {
  if (!hex.startsWith("#") || (hex.length !== 4 && hex.length !== 7))
    return undefined;
  const rgb = parseHexColor(hex);
  if (
    !Number.isFinite(rgb.r) ||
    !Number.isFinite(rgb.g) ||
    !Number.isFinite(rgb.b)
  )
    return undefined;
  return (
    0.2126 * linearizeChannel(rgb.r) +
    0.7152 * linearizeChannel(rgb.g) +
    0.0722 * linearizeChannel(rgb.b)
  );
}

/** Angular distance between two hue values (0-360). */
function hueDistance(a: number, b: number): number {
  const distance = Math.abs(a - b);
  return Math.min(distance, 360 - distance);
}

const V18_HUE_DISTANCE = 10;
const V18_MIN_CHROMA = 0.03;
const V18_ACCENT_MIN_CONTRAST = 3;
const V18_DEFAULT_CHROMA_SCALE = 0.7;
const V18_MIN_OUT_CHROMA = 0.05;
const V18_MAX_OUT_CHROMA = 0.21;
const V18_MIN_LIGHTNESS = 0.65;
const V18_MAX_LIGHTNESS = 0.88;
const V18_LIGHT_BANDS: ReadonlyArray<readonly [number, number]> = [[195, 330]];
/** Dark themes only allow hues whose most vivid form stays below max lightness. */
const V18_DARK_BANDS: ReadonlyArray<readonly [number, number]> = (() => {
  const bands: Array<[number, number]> = [];
  let start = -1;
  for (let hue = 0; hue <= 360; hue += 1) {
    if (hue < 360 && vividOklchForHue(hue).l <= V18_MAX_LIGHTNESS) {
      if (start < 0) start = hue;
    } else if (start >= 0) {
      bands.push([start, hue - 1]);
      start = -1;
    }
  }
  return bands;
})();

function bandsWidth(bands: ReadonlyArray<readonly [number, number]>): number {
  let width = 0;
  for (const [lo, hi] of bands) width += hi - lo + 1;
  return width;
}

/**
 * Host `uNa`: map the hash onto a band hue at least `V18_HUE_DISTANCE` from
 * every occupied theme hue, scanning outward and staying inside the bands.
 */
function findSafeHue(
  targetIndex: number,
  occupied: number[],
  bands: ReadonlyArray<readonly [number, number]>,
): number {
  const width = bandsWidth(bands);
  const hueAt = (index: number) => {
    let offset = Math.max(0, Math.min(width - 1, index));
    for (const [lo, hi] of bands) {
      const bandWidth = hi - lo + 1;
      if (offset < bandWidth) return lo + offset;
      offset -= bandWidth;
    }
    return bands[bands.length - 1]?.[1] ?? 0;
  };
  const target = hueAt(targetIndex);
  if (occupied.length === 0) return target;
  if (occupied.every((hue) => hueDistance(target, hue) >= V18_HUE_DISTANCE))
    return target;
  for (let distance = 1; distance < width; distance += 1) {
    for (const direction of [1, -1]) {
      const candidate = hueAt(targetIndex + distance * direction);
      if (
        occupied.every((hue) => hueDistance(candidate, hue) >= V18_HUE_DISTANCE)
      )
        return candidate;
    }
  }
  return target;
}

/** Host `getSessionAccentHex`: name hash → OKLCH hue-band accent. */
function computeSessionAccentHex(
  name: string,
  inputs: SessionAccentInputs,
): string {
  const surfaceLuminance = inputs.surfaceLuminance;
  const dark = surfaceLuminance === undefined;
  const bands = dark ? V18_DARK_BANDS : V18_LIGHT_BANDS;
  const occupied = inputs.colorHexes
    .map((hex) => {
      const oklch = oklchFromHex(hex);
      return Number.isFinite(oklch.h) && oklch.c >= V18_MIN_CHROMA
        ? oklch.h
        : undefined;
    })
    .filter((hue): hue is number => hue !== undefined);
  const hue = findSafeHue(
    sessionNameHash(name) % bandsWidth(bands),
    occupied,
    bands,
  );
  const accent =
    inputs.accentHex === undefined ? undefined : oklchFromHex(inputs.accentHex);
  const hasAccent =
    accent !== undefined &&
    Number.isFinite(accent.l) &&
    Number.isFinite(accent.c) &&
    Number.isFinite(accent.h) &&
    accent.c >= V18_MIN_CHROMA;
  const vivid = vividOklchForHue(hue);
  let lightness: number;
  let chromaScale: number;
  if (hasAccent && accent !== undefined) {
    const reference = vividOklchForHue(accent.h);
    lightness =
      accent.l <= reference.l
        ? (accent.l / reference.l) * vivid.l
        : vivid.l +
          ((accent.l - reference.l) / (1 - reference.l)) * (1 - vivid.l);
    chromaScale = accent.c / reference.c;
  } else {
    lightness = vivid.l;
    chromaScale = V18_DEFAULT_CHROMA_SCALE;
  }
  const chroma = Math.max(
    V18_MIN_OUT_CHROMA,
    Math.min(V18_MAX_OUT_CHROMA, chromaScale * vivid.c),
  );
  if (dark)
    return oklchToHex({
      l: Math.max(V18_MIN_LIGHTNESS, Math.min(V18_MAX_LIGHTNESS, lightness)),
      c: chroma,
      h: hue,
    });
  const cap = Math.max(
    0,
    (surfaceLuminance + 0.05) / V18_ACCENT_MIN_CONTRAST - 0.05,
  );
  const candidate = oklchToHex({ l: lightness, c: chroma, h: hue });
  if ((hexRelativeLuminance(candidate) ?? 0) <= cap) return candidate;
  let lo = 0;
  let hi = lightness;
  for (let index = 0; index < 20; index += 1) {
    const mid = (lo + hi) / 2;
    const probe = oklchToHex({ l: mid, c: chroma, h: hue });
    if ((hexRelativeLuminance(probe) ?? 0) > cap) hi = mid;
    else lo = mid;
  }
  return oklchToHex({ l: lo, c: chroma, h: hue });
}

const ACCENT_CACHE_LIMIT = 256;
const accentCache = new Map<string, string>();

function cachedSessionAccent(key: string, compute: () => string): string {
  const cached = accentCache.get(key);
  if (cached !== undefined) return cached;
  const value = compute();
  if (accentCache.size >= ACCENT_CACHE_LIMIT) {
    const oldest = accentCache.keys().next().value;
    if (oldest !== undefined) accentCache.delete(oldest);
  }
  accentCache.set(key, value);
  return value;
}

/** Per-name accent for the given host theme inputs, memoized like the host. */
export function getSessionAccentHex(
  name: string,
  inputs: SessionAccentInputs,
): string {
  const key = `${name}\x00${inputs.accentHex ?? ""}\x00${inputs.surfaceLuminance ?? ""}\x00${inputs.colorHexes.join(",")}`;
  return cachedSessionAccent(key, () => computeSessionAccentHex(name, inputs));
}

