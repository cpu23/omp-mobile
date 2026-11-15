export type AppendPlain = (parent: HTMLElement, text: string) => void;

const MAX_SVG_CHARS = 1_000_000;
const MAX_SVG_NODES = 20_000;
const MAX_MATH_LENGTH = 10_000;
const MAX_IMAGE_SOURCE_LENGTH = 3 * 1024 * 1024;
const MAX_MERMAID_CHARS = 100_000;
const MAX_CHART_ROWS = 40;
const MAX_CHART_COLUMNS = 16;
const MAX_CHART_TEXT = 64_000;
const CHART_THEME_ALIASES: Record<string, string> = {
  "--fg": "--text",
  "--border": "--line",
  "--surface": "--panel-soft",
  "--c1": "--accent",
  "--c2": "--success",
  "--c3": "--warn",
  "--c4": "--danger",
  "--c5": "--text",
  "--c6": "--muted",
  "--warning": "--warn",
  "--error": "--danger",
};
let figureSerial = 0;
let mermaidSerial = 0;

const SVG_TAGS: Record<string, true> = {
  svg: true, g: true, path: true, rect: true, circle: true, ellipse: true, line: true,
  polyline: true, polygon: true, text: true, tspan: true, title: true, desc: true,
  defs: true, lineargradient: true, radialgradient: true, stop: true, clippath: true,
  mask: true, pattern: true, marker: true, symbol: true, use: true, filter: true,
  fegaussianblur: true, feoffset: true, fecolormatrix: true, feblend: true,
  fecomposite: true, femerge: true, femergenode: true, feflood: true,
  femorphology: true, feturbulence: true, fedisplacementmap: true,
  fecomponenttransfer: true, fefuncr: true, fefuncg: true, fefuncb: true,
  fefunca: true, style: true,
};
const SVG_ATTRIBUTES: Record<string, true> = {
  xmlns: true, "xmlns:xlink": true, version: true, viewbox: true, width: true,
  height: true, x: true, y: true, x1: true, x2: true, y1: true, y2: true, cx: true,
  cy: true, r: true, rx: true, ry: true, d: true, points: true, fill: true,
  "fill-rule": true, "fill-opacity": true, stroke: true, "stroke-width": true,
  "stroke-linecap": true, "stroke-linejoin": true, "stroke-dasharray": true,
  "stroke-dashoffset": true, "stroke-opacity": true, "stop-color": true, "stop-opacity": true,
  "flood-color": true, "flood-opacity": true, opacity: true, transform: true,
  "font-weight": true, "font-style": true, "letter-spacing": true, id: true, class: true,
  role: true, "aria-label": true, "aria-labelledby": true, "aria-hidden": true,
  tabindex: true, offset: true, gradientunits: true, gradienttransform: true,
  spreadmethod: true, clippathunits: true, maskunits: true, maskcontentunits: true,
  patternunits: true, patterncontentunits: true, patterntransform: true,
  markerwidth: true, markerheight: true, refx: true, refy: true, orient: true,
  filterunits: true, primitiveunits: true, stddeviation: true, dx: true, dy: true,
  values: true, type: true, in: true, result: true, mode: true, operator: true,
  k1: true, k2: true, k3: true, k4: true, preserveaspectratio: true, href: true,
  "xlink:href": true, style: true, "clip-path": true, mask: true, filter: true,
  "marker-start": true, "marker-mid": true, "marker-end": true, color: true,
  "xml:space": true,
};
const SVG_REFERENCE_ATTRIBUTES: Record<string, true> = {
  fill: true, stroke: true, filter: true, "clip-path": true, mask: true, "marker-start": true,
  "marker-mid": true, "marker-end": true,
};
const INLINE_STYLE_PROPERTIES: Record<string, true> = {
  color: true, fill: true, "fill-rule": true, "fill-opacity": true, stroke: true,
  "stroke-width": true, "stroke-linecap": true, "stroke-linejoin": true,
  "stroke-dasharray": true, "stroke-dashoffset": true, "stroke-opacity": true,
  opacity: true, "font-family": true, "font-size": true, "font-weight": true,
  "font-style": true, "letter-spacing": true, "text-anchor": true,
  "dominant-baseline": true, "clip-path": true, mask: true, filter: true,
  "marker-start": true, "marker-mid": true, "marker-end": true, "stop-color": true,
  "stop-opacity": true, "flood-color": true, "flood-opacity": true,
  "paint-order": true, "vector-effect": true,
};
const THEME_VARIABLES = [
  "--text", "--bg", "--panel-soft", "--line", "--accent", "--muted", "--success", "--danger", "--error",
  "--warn", "--warning", "--md-heading", "--md-link", "--fg", "--border", "--surface",
  "--c1", "--c2", "--c3", "--c4", "--c5", "--c6",
] as const;

/**
 * Sanitizes SVG markup before it is placed in an isolated data-image context.
 * Only a small SVG vocabulary is retained; event handlers, active content,
 * foreign objects, non-fragment references, and resource-loading CSS are removed.
 */
export function sanitizeSvgMarkup(markup: string, themeSource?: Element): string | null {
  if (
    markup.length > MAX_SVG_CHARS ||
    /<!doctype|<!entity/i.test(markup) ||
    typeof DOMParser === "undefined" ||
    typeof XMLSerializer === "undefined"
  ) {
    return null;
  }

  let document: Document;
  try {
    document = new DOMParser().parseFromString(markup, "image/svg+xml");
  } catch {
    return null;
  }
  const root = document.documentElement;
  const svgNamespace = "http://www.w3.org/2000/svg";
  if (
    root.localName.toLowerCase() !== "svg" ||
    (root.namespaceURI && root.namespaceURI !== svgNamespace) ||
    document.querySelector("parsererror")
  ) {
    return null;
  }
  if (!root.hasAttribute("xmlns")) root.setAttribute("xmlns", svgNamespace);

  const elements = [root, ...Array.from(root.querySelectorAll("*"))];
  if (elements.length > MAX_SVG_NODES) return null;
  for (const element of elements) {
    const tag = element.localName.toLowerCase();
    if ((element.namespaceURI && element.namespaceURI !== svgNamespace) || SVG_TAGS[tag] !== true) {
      element.remove();
      continue;
    }
    if (tag === "style") {
      const safeCss = sanitizeSvgStyleSheet(element.textContent ?? "");
      if (!safeCss) {
        element.remove();
        continue;
      }
      element.textContent = safeCss;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        /^on[a-z]/i.test(name) ||
        SVG_ATTRIBUTES[name] !== true ||
        (name === "xmlns" && value !== svgNamespace) ||
        (name === "xmlns:xlink" && value !== "http://www.w3.org/1999/xlink") ||
        (name === "href" || name === "xlink:href") && !/^#[\w.:-]+$/.test(value) ||
        name === "aria-labelledby" && !/^[\w.\s:-]+$/.test(value)
      ) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "xmlns" || name === "xmlns:xlink") continue;
      if (name === "style") {
        const safeStyle = sanitizeInlineStyle(value);
        if (safeStyle) element.setAttribute(attribute.name, safeStyle);
        else element.removeAttribute(attribute.name);
      } else if (SVG_REFERENCE_ATTRIBUTES[name] === true && /(?:url\s*\(|javascript:|data:|https?:|\/\/)/i.test(value)) {
        const internalUrl = /^url\(\s*#[\w.:-]+\s*\)$/i.test(value);
        if (!internalUrl) element.removeAttribute(attribute.name);
      }
    }
  }

  const themeValues = readThemeValues(themeSource);
  const rootStyles = [
    sanitizeInlineStyle(root.getAttribute("style") ?? "") ?? "",
    ...Object.entries(themeValues).map(([name, value]) => `${name}:${value}`),
  ];
  if (themeValues["--text"]) rootStyles.push(`color:${themeValues["--text"]}`);
  const safeRootStyle = rootStyles.filter(Boolean).join(";");
  if (safeRootStyle) root.setAttribute("style", safeRootStyle);
  return new XMLSerializer().serializeToString(root);
}

function sanitizeInlineStyle(style: string): string | null {
  const normalized = style.replace(/\/\*[\s\S]*?\*\//g, "");
  if (/[\\@]|expression\s*\(|-moz-binding|behavior\s*:|javascript:|data:/i.test(normalized)) return null;
  const kept: string[] = [];
  for (const declaration of normalized.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration.slice(separator + 1).trim();
    if (INLINE_STYLE_PROPERTIES[property] !== true || !value) continue;
    const urls = [...value.matchAll(/url\(([^)]*)\)/gi)];
    if (urls.some((match) => !/^\s*(?:(["'])#[\w.:-]+\1|#[\w.:-]+)\s*$/.test(match[1]))) continue;
    kept.push(`${property}:${value}`);
  }
  return kept.length ? kept.join(";") : null;
}

function sanitizeSvgStyleSheet(css: string): string | null {
  if (css.length > 100_000 || typeof CSSStyleSheet === "undefined") return null;
  try {
    // Keep the constructed sheet detached; only parsed style rules are serialized.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    const safeRules: string[] = [];
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule.type !== 1) continue; // Drop every at-rule, including @import and keyframes.
      const styleRule = rule as CSSStyleRule;
      const selector = styleRule.selectorText.trim();
      if (!selector || selector.length > 1_000 || !/^[\w\s.#,:>+~*()[\]="'^$|=-]+$/.test(selector)) continue;
      const declarations = sanitizeInlineStyle(styleRule.style.cssText);
      if (declarations) safeRules.push(`${selector}{${declarations}}`);
    }
    return safeRules.join("") || null;
  } catch {
    return null;
  }
}

function readThemeValues(source?: Element): Record<string, string> {
  const values: Record<string, string> = {};
  const target = source?.isConnected ? source : typeof document !== "undefined" ? document.documentElement : undefined;
  if (!target || typeof getComputedStyle !== "function") return values;
  try {
    const computed = getComputedStyle(target);
    for (const name of THEME_VARIABLES) {
      const value = computed.getPropertyValue(name).trim();
      if (value && /^[#\w\s(),.%+-]+$/.test(value) && !/(?:url\s*\(|var\s*\(|javascript:|data:)/i.test(value)) values[name] = value;
    }
    for (const [alias, fallback] of Object.entries(CHART_THEME_ALIASES)) {
      if (!values[alias] && values[fallback]) values[alias] = values[fallback];
    }
  } catch {
    // Detached or non-browser test DOMs simply use the diagram defaults.
  }
  return values;
}


function hasRasterSignature(mime: string, payload: string, base64: boolean): boolean {
  let signature = "";
  if (base64) {
    if (!/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(payload)) return false;
    try {
      signature = atob(payload.slice(0, 64));
    } catch {
      return false;
    }
  } else {
    for (let index = 0; index < payload.length && signature.length < 12;) {
      const char = payload[index++];
      if (char === "%") {
        const hex = payload.slice(index, index + 2);
        if (!/^[a-f0-9]{2}$/i.test(hex)) return false;
        signature += String.fromCharCode(Number.parseInt(hex, 16));
        index += 2;
      } else {
        const code = char.charCodeAt(0);
        if (code < 0x20 || code > 0x7e) return false;
        signature += char;
      }
    }
  }
  const type = mime.toLowerCase();
  return type === "png" ? signature.startsWith("\x89PNG\r\n\x1a\n") :
    type === "jpeg" || type === "jpg" ? signature.startsWith("\xff\xd8\xff") :
    type === "gif" ? /^GIF8[79]a/.test(signature) :
    type === "webp" ? signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP" :
    type === "bmp" ? signature.startsWith("BM") :
    type === "x-icon" ? signature.startsWith("\x00\x00\x01\x00") :
    type === "avif" ? signature.slice(4, 12).includes("ftypavif") :
    false;
}

function safeImageUrl(raw: string): string | null {
  if (raw.length > MAX_IMAGE_SOURCE_LENGTH || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  if (/^data:/i.test(raw)) {
    const data = raw.match(/^data:image\/(png|jpeg|jpg|gif|webp|avif|bmp|x-icon)(?:;charset=[a-z0-9._-]+)?(;base64)?,(.*)$/i);
    if (!data || !hasRasterSignature(data[1], data[3], Boolean(data[2]))) return null;
    return raw;
  }
  try {
    const url = new URL(raw);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      !/\.(?:png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(url.pathname)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function createSourceFigure(parent: HTMLElement, className: string, sourceText: string): {
  figure: HTMLElement;
  content: HTMLElement;
} {
  const figure = document.createElement("figure");
  figure.className = `rich-figure ${className}`;
  const toolbar = document.createElement("div");
  toolbar.className = "rich-toolbar";
  const source = document.createElement("pre");
  source.className = "rich-source";
  source.textContent = sourceText;
  source.hidden = true;
  const sourceId = `rich-source-${++figureSerial}`;
  source.id = sourceId;
  const sourceButton = document.createElement("button");
  sourceButton.type = "button";
  sourceButton.className = "rich-source-toggle";
  sourceButton.textContent = "Source";
  sourceButton.setAttribute("aria-expanded", "false");
  sourceButton.setAttribute("aria-controls", sourceId);
  sourceButton.addEventListener("click", () => {
    source.hidden = !source.hidden;
    sourceButton.setAttribute("aria-expanded", String(!source.hidden));
  });
  toolbar.append(sourceButton);
  const zoomButton = document.createElement("button");
  zoomButton.type = "button";
  zoomButton.className = "rich-zoom-toggle";
  zoomButton.textContent = "Zoom";
  zoomButton.setAttribute("aria-pressed", "false");
  zoomButton.addEventListener("click", () => {
    const zoomed = figure.classList.toggle("rich-zoomed");
    zoomButton.setAttribute("aria-pressed", String(zoomed));
  });
  toolbar.append(zoomButton);
  const content = document.createElement("div");
  content.className = "rich-content";
  figure.append(toolbar, content, source);
  parent.append(figure);
  return { figure, content };
}

type ImageBudget = { dataCharactersRemaining: number };

function appendImage(parent: HTMLElement, source: string, alt: string, imageBudget: ImageBudget): boolean {
  const isDataImage = /^data:/i.test(source);
  if (isDataImage && source.length > imageBudget.dataCharactersRemaining) return false;
  const url = safeImageUrl(source);
  if (!url) return false;
  if (isDataImage) imageBudget.dataCharactersRemaining -= source.length;
  const { content } = createSourceFigure(parent, "rich-image", source);
  const image = document.createElement("img");
  image.className = "rich-image-view";
  image.src = url;
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  content.append(image);
  return true;
}

function appendSvg(parent: HTMLElement, markup: string, source: string, className: string, alt?: string): boolean {
  const safeSvg = sanitizeSvgMarkup(markup, parent.closest(".part-text") ?? parent);
  if (!safeSvg) return false;
  const { content } = createSourceFigure(parent, className, source);
  const image = document.createElement("img");
  image.className = "rich-svg-view";
  image.alt = alt ?? (className === "rich-diagram" ? "Mermaid diagram" : "SVG illustration");
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safeSvg)}`;
  content.append(image);
  return true;
}

async function renderMermaid(parent: HTMLElement, source: string): Promise<void> {
  const { content } = createSourceFigure(parent, "rich-diagram", source);
  content.classList.add("rich-diagram-content");
  const placeholder = document.createElement("p");
  placeholder.className = "rich-render-status";
  placeholder.textContent = "Rendering diagram…";
  content.append(placeholder);
  try {
    // A fixed-specifier dynamic import keeps this engine out of the initial client chunk.
    const { renderMermaidSvg } = await import("./rich-mermaid");
    const rendered = await renderMermaidSvg(
      `omp-mobile-mermaid-${++mermaidSerial}`,
      source,
      readThemeValues(parent.closest(".part-text") ?? parent),
    );
    if (!appendSvgInto(content, rendered, "Mermaid diagram")) throw new Error("Unsafe Mermaid SVG output");
  } catch {
    content.replaceChildren();
    const fallback = document.createElement("pre");
    fallback.className = "rich-source-fallback";
    fallback.textContent = source;
    content.append(fallback);
  }
}

function appendSvgInto(parent: HTMLElement, markup: string, alt: string): boolean {
  const safeSvg = sanitizeSvgMarkup(markup, parent.closest(".part-text") ?? parent);
  if (!safeSvg) return false;
  const image = document.createElement("img");
  image.className = "rich-svg-view";
  image.alt = alt;
  image.loading = "lazy";
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(safeSvg)}`;
  parent.replaceChildren(image);
  return true;
}

function appendMath(parent: HTMLElement, source: string, display: boolean, original: string): HTMLElement | null {
  if (!source.trim() || source.length > MAX_MATH_LENGTH) return null;
  const wrapper = document.createElement(display ? "div" : "span");
  wrapper.className = display ? "rich-math rich-math-display" : "rich-math";
  parent.append(wrapper);
  // A fixed-specifier dynamic import keeps KaTeX and its stylesheet out of the initial client chunk.
  void import("./rich-katex")
    .then(({ renderKatex }) => {
      if (!renderKatex(wrapper, source, display)) wrapper.replaceWith(document.createTextNode(original));
    })
    .catch(() => wrapper.replaceWith(document.createTextNode(original)));
  return wrapper;
}

function parseImageAt(text: string, index: number): { end: number; alt: string; source: string } | null {
  if (!text.startsWith("![", index) || isEscaped(text, index)) return null;
  const altEnd = text.indexOf("](", index + 2);
  if (altEnd < 0 || text.slice(index, altEnd).includes("\n")) return null;
  let end = text.indexOf(")", altEnd + 2);
  if (end < 0 || text.slice(altEnd + 2, end).includes("\n")) return null;
  let source = text.slice(altEnd + 2, end).trim();
  if (source.startsWith("<") && source.endsWith(">")) source = source.slice(1, -1);
  const titleStart = source.search(/\s+["']/);
  if (titleStart >= 0) source = source.slice(0, titleStart);
  const alt = text.slice(index + 2, altEnd).replace(/\\([\\[\]])/g, "$1");
  return source ? { end: end + 1, alt, source } : null;
}

function isEscaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function findMathEnd(text: string, start: number, delimiter: string): number {
  let index = start + delimiter.length;
  while (index < text.length) {
    const found = text.indexOf(delimiter, index);
    if (found < 0 || text.slice(index, found).includes("\n")) return -1;
    const currencyMarker = delimiter === "$" && /\d/.test(text[found + 1] ?? "");
    if (!currencyMarker && !isEscaped(text, found) && found > start + delimiter.length && (delimiter === "$$" || !/\s/.test(text[found - 1]))) return found;
    index = found + delimiter.length;
  }
  return -1;
}

function appendInlineRich(parent: HTMLElement, text: string, appendPlain: AppendPlain, imageBudget: ImageBudget): void {
  const replacements = new Map<string, Node>();
  let maskedText = "";
  let plainStart = 0;
  let index = 0;
  const replaceRange = (start: number, end: number, replacement: Node): void => {
    maskedText += text.slice(plainStart, start);
    const random = window.crypto.getRandomValues(new Uint8Array(16));
    let placeholder = "\uE000";
    for (const byte of random) placeholder += String.fromCharCode(0xe100 + byte);
    placeholder += "\uE001";
    maskedText += placeholder;
    replacements.set(placeholder, replacement);
    plainStart = end;
  };

  while (index < text.length) {
    if (text[index] === "`") {
      const run = text.slice(index).match(/^`+/)?.[0] ?? "`";
      const close = text.indexOf(run, index + run.length);
      if (close >= 0) {
        index = close + run.length;
        continue;
      }
    }
    const image = parseImageAt(text, index);
    if (image) {
      const holder = document.createElement("div");
      if (appendImage(holder, image.source, image.alt, imageBudget) && holder.firstChild) {
        replaceRange(index, image.end, holder.firstChild);
      }
      index = image.end;
      continue;
    }
    if (!isEscaped(text, index) && text.startsWith("\\(", index)) {
      const close = text.indexOf("\\)", index + 2);
      if (close >= 0 && !text.slice(index + 2, close).includes("\n")) {
        const holder = document.createElement("div");
        if (appendMath(holder, text.slice(index + 2, close), false, text.slice(index, close + 2)) && holder.firstChild) {
          replaceRange(index, close + 2, holder.firstChild);
        }
        index = close + 2;
        continue;
      }
    }
    if (!isEscaped(text, index) && text.startsWith("$$", index)) {
      const close = findMathEnd(text, index, "$$");
      if (close >= 0) {
        const holder = document.createElement("div");
        if (appendMath(holder, text.slice(index + 2, close), true, text.slice(index, close + 2)) && holder.firstChild) {
          replaceRange(index, close + 2, holder.firstChild);
        }
        index = close + 2;
        continue;
      }
    }
    if (text[index] === "$" && !isEscaped(text, index)) {
      const close = findMathEnd(text, index, "$");
      if (close >= 0 && /[\p{L}\\_^{}=<>+*/]/u.test(text.slice(index + 1, close))) {
        const holder = document.createElement("div");
        if (appendMath(holder, text.slice(index + 1, close), false, text.slice(index, close + 1)) && holder.firstChild) {
          replaceRange(index, close + 1, holder.firstChild);
        }
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }

  maskedText += text.slice(plainStart);
  appendPlain(parent, maskedText);
  if (replacements.size === 0) return;
  const pattern = new RegExp([...replacements.keys()].join("|"), "g");
  const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    textNodes.push(node as Text);
    node = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;
    let replaced = false;
    while ((match = pattern.exec(textNode.data)) !== null) {
      if (match.index > offset) fragment.append(document.createTextNode(textNode.data.slice(offset, match.index)));
      const replacement = replacements.get(match[0]);
      if (replacement) {
        fragment.append(replacement);
        replaced = true;
      } else {
        fragment.append(document.createTextNode(match[0]));
      }
      offset = match.index + match[0].length;
    }
    if (replaced) {
      if (offset < textNode.data.length) fragment.append(document.createTextNode(textNode.data.slice(offset)));
      textNode.replaceWith(fragment);
    }
  }
}

function parseTable(line: string, delimiter: string): { headers: string[]; rows: string[][] } | null {
  if (!line.includes("|") || !delimiter.includes("-")) return null;
  const split = (value: string): string[] => {
    let row = value.trim();
    if (row.startsWith("|")) row = row.slice(1);
    if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
    return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  };
  const headers = split(line);
  const separators = split(delimiter);
  if (headers.length < 2 || separators.length !== headers.length || separators.some((cell) => !/^:?-{1,}:?$/.test(cell))) return null;
  return { headers, rows: [] };
}

async function appendChart(parent: HTMLElement, table: { headers: string[]; rows: string[][] }, markdown: string): Promise<void> {
  if (
    table.headers.length < 2 ||
    table.headers.length > MAX_CHART_COLUMNS ||
    table.rows.length < 2 ||
    table.rows.length > MAX_CHART_ROWS ||
    table.rows.some((row) => row.length !== table.headers.length)
  ) return;
  const textLength = table.headers.reduce((length, cell) => length + cell.length, 0) +
    table.rows.reduce((length, row) => length + row.reduce((rowLength, cell) => rowLength + cell.length, 0), 0);
  if (textLength > MAX_CHART_TEXT) return;
  const { figure, content } = createSourceFigure(parent, "rich-chart-wrap", markdown);
  figure.hidden = true;
  try {
    // A fixed-specifier dynamic import keeps charting out of the initial client chunk.
    const { renderTableChartSvg } = await import("./rich-chart");
    const svg = renderTableChartSvg(table.headers, table.rows);
    const alt = `Chart based on table: ${table.headers.join(", ")}`;
    if (!svg || !appendSvgInto(content, svg, alt)) {
      figure.remove();
      return;
    }
    figure.hidden = false;
  } catch {
    // Complex or malformed tables remain available in their original Markdown form.
    figure.remove();
  }
}


function processTable(
  parent: HTMLElement,
  lines: string[],
  start: number,
  appendPlain: AppendPlain,
  imageBudget: ImageBudget,
): number {
  const parsed = parseTable(lines[start], lines[start + 1] ?? "");
  if (!parsed) return start;
  let end = start + 2;
  while (end < lines.length && lines[end].includes("|") && !/^\s*$/.test(lines[end])) end += 1;
  const rows = lines.slice(start + 2, end).map((line) => {
    const row = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
  });
  const markdown = lines.slice(start, end).join("\n");
  appendInlineRich(parent, markdown, appendPlain, imageBudget);
  parsed.rows = rows;
  const tableWrap = parent.lastElementChild;
  if (tableWrap?.querySelector("table")) void appendChart(parent, parsed, markdown);
  return end;
}


function appendFallbackCode(parent: HTMLElement, language: string, source: string): void {
  const wrap = document.createElement("div");
  wrap.className = "code-wrap";
  const pre = document.createElement("pre");
  pre.className = "rich-source-fallback";
  pre.textContent = source;
  if (language) pre.dataset.language = language;
  wrap.append(pre);
  parent.append(wrap);
}

function findClosingFence(lines: string[], start: number, fence: string): number {
  const marker = fence[0];
  const minimum = fence.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (new RegExp(`^\\s*${marker === "`" ? "`" : "~"}{${minimum},}\\s*$`).test(lines[index])) return index;
  }
  return -1;
}

function appendDisplayMath(parent: HTMLElement, source: string, original: string, appendPlain: AppendPlain): void {
  if (!appendMath(parent, source, true, original)) appendPlain(parent, original);
}

/**
 * Adds local diagrams, SVG, safe math, raster images, and conservative table charts;
 * all ordinary Markdown is delegated back to the existing renderer unchanged.
 */
export function appendRichContent(parent: HTMLElement, rawText: string, appendPlain: AppendPlain): void {
  if (!rawText) return;
  const text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  let index = 0;
  let plainStart = 0;
  const imageBudget: ImageBudget = { dataCharactersRemaining: MAX_IMAGE_SOURCE_LENGTH };
  const flush = (end: number): void => {
    if (end > plainStart) appendInlineRich(parent, lines.slice(plainStart, end).join("\n"), appendPlain, imageBudget);
  };

  while (index < lines.length) {
    const fenceMatch = lines[index].match(/^\s*(`{3,}|~{3,})([^`]*)$/);
    if (fenceMatch) {
      flush(index);
      const closing = findClosingFence(lines, index, fenceMatch[1]);
      if (closing < 0) {
        const info = fenceMatch[2].trim();
        const language = info.split(/\s+/, 1)[0].toLowerCase();
        appendFallbackCode(parent, language, lines.slice(index + 1).join("\n"));
        return;
      }
      const info = fenceMatch[2].trim();
      const language = info.split(/\s+/, 1)[0].toLowerCase();
      const source = lines.slice(index + 1, closing).join("\n");
      const original = lines.slice(index, closing + 1).join("\n");
      if (language === "mermaid") {
        if (source.length > MAX_MERMAID_CHARS) appendFallbackCode(parent, language, source);
        else void renderMermaid(parent, source);
      } else if (language === "svg") {
        if (!appendSvg(parent, source, source, "rich-svg")) appendFallbackCode(parent, language, source);
      } else if (fenceMatch[1][0] === "~") {
        appendFallbackCode(parent, language, source);
      } else {
        appendPlain(parent, original);
      }
      index = closing + 1;
      plainStart = index;
      continue;
    }

    const displayStart = /^\s*(\$\$|\\\[)\s*$/.exec(lines[index]);
    if (displayStart) {
      flush(index);
      const closingToken = displayStart[1] === "$$" ? /^\s*\$\$\s*$/ : /^\s*\\\]\s*$/;
      let closing = index + 1;
      while (closing < lines.length && !closingToken.test(lines[closing])) closing += 1;
      if (closing >= lines.length) {
        appendPlain(parent, lines.slice(index).join("\n"));
        return;
      }
      const source = lines.slice(index + 1, closing).join("\n");
      appendDisplayMath(parent, source, lines.slice(index, closing + 1).join("\n"), appendPlain);
      index = closing + 1;
      plainStart = index;
      continue;
    }

    if (index + 1 < lines.length && parseTable(lines[index], lines[index + 1])) {
      flush(index);
      index = processTable(parent, lines, index, appendPlain, imageBudget);
      plainStart = index;
      continue;
    }
    index += 1;
  }
  flush(lines.length);
}
