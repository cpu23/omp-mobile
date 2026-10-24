import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { appendRichContent, sanitizeSvgMarkup } from "./rich-content";

const browser = new Window();
browser.document.write("<!doctype html><html><head></head><body></body></html>");
// happy-dom lacks compatMode; the shipped HTML uses a standards doctype.
Object.defineProperty(browser.document, "compatMode", { value: "CSS1Compat" });
const domGlobals = {
  window: browser,
  document: browser.document,
  DOMParser: browser.DOMParser,
  XMLSerializer: browser.XMLSerializer,
  NodeFilter: browser.NodeFilter,
  CSSStyleSheet: browser.CSSStyleSheet,
  getComputedStyle: browser.getComputedStyle.bind(browser),
};
const originalGlobals = new Map(
  Object.keys(domGlobals).map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ]),
);
for (const [name, value] of Object.entries(domGlobals))
  Object.defineProperty(globalThis, name, { configurable: true, value });

const appendPlain = (parent: HTMLElement, text: string): void => {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  parent.append(paragraph);
};

afterAll(async () => {
  await browser.happyDOM.abort();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("SVG sanitizer removes active content, foreign objects, external references, and resource CSS", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="globalThis.compromised=true">
    <script>globalThis.compromised = true</script>
    <foreignObject><iframe src="https://attacker.invalid"></iframe></foreignObject>
    <a href="https://attacker.invalid/" onclick="globalThis.compromised=true"><text>link</text></a>
    <image href="data:image/svg+xml,%3Csvg%20onload=alert(1)%2F%3E" />
    <style onload="globalThis.compromised=true">.safe{fill:red}</style>
    <style>.shape{fill:red;background-image:u/**/rl(https://attacker.invalid/a)}</style>
    <rect id="safe" width="10" height="10" fill="url(#safe)" style="stroke:#123456" />
    <use id="safe-use" href="#safe" />
    <use id="unsafe-use" href="https://attacker.invalid/payload.svg#safe" />
    <rect id="unsafe" width="10" height="10" stroke="url(https://attacker.invalid/stroke.svg)" style="fill:u\\72l(https://attacker.invalid/a)" />
  </svg>`;
  const safe = sanitizeSvgMarkup(svg);
  expect(safe).not.toBeNull();
  expect(safe).not.toMatch(/<script|foreignObject|<image|onclick|onload|attacker\.invalid|u\\72l/i);
  expect(safe).toContain('id="safe"');
  expect(safe).toContain('xmlns="http://www.w3.org/2000/svg"');
  expect(safe).toContain('fill="url(#safe)"');
  expect(safe).toContain('stroke:#123456');
});
test("SVG gradient and filter colors preserve safe presentation attributes", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <defs>
      <linearGradient id="paint"><stop offset="0%" stop-color="#00ff00" stop-opacity="0.5" /></linearGradient>
      <filter id="wash"><feFlood flood-color="#ff0000" flood-opacity="0.25" /></filter>
    </defs>
    <rect width="10" height="10" fill="url(#paint)" filter="url(#wash)" />
  </svg>`;
  const safe = sanitizeSvgMarkup(svg);
  expect(safe).toContain('stop-color="#00ff00"');
  expect(safe).toContain('stop-opacity="0.5"');
  expect(safe).toContain('flood-color="#ff0000"');
  expect(safe).toContain('flood-opacity="0.25"');
});

test("SVG sanitizer keeps safe Mermaid-style rules without imports or animation", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
    <style onload="globalThis.compromised=true">
      .edgePath path { marker-end: url(#arrowhead); stroke: var(--line); }
      @keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
      .external { fill: url("https://attacker.invalid/image.svg"); }
    </style>
  </svg>`;
  const safe = sanitizeSvgMarkup(svg);
  const parsed = new DOMParser().parseFromString(safe ?? "", "image/svg+xml");
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(parsed.querySelector("style")?.textContent ?? "");
  const edgeRule = Array.from(sheet.cssRules).find(
    (rule) => rule.type === 1 && (rule as CSSStyleRule).selectorText === ".edgePath path",
  ) as CSSStyleRule | undefined;
  expect(edgeRule?.style.getPropertyValue("marker-end")).toBe("url(#arrowhead)");
  expect(edgeRule?.style.getPropertyValue("stroke")).toBe("var(--line)");
  const imported = sanitizeSvgMarkup(
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://attacker.invalid/theme.css");</style></svg>',
  );
  expect(imported).not.toMatch(/attacker\.invalid|@import/i);
  expect(safe).not.toMatch(/attacker\.invalid|@import|@keyframes|pulse|onload/i);
});


test("detached SVGs resolve theme tokens from the connected document root", () => {
  const root = browser.document.documentElement;
  const previousAccent = root.style.getPropertyValue("--accent");
  root.style.setProperty("--accent", "#123456");
  try {
    const safe = sanitizeSvgMarkup(
      '<svg xmlns="http://www.w3.org/2000/svg"><path fill="var(--accent)" /></svg>',
      document.createElement("div"),
    );
    expect(safe).toContain("--accent:#123456");
  } finally {
    if (previousAccent) root.style.setProperty("--accent", previousAccent);
    else root.style.removeProperty("--accent");
  }
});


test("SVG sanitizer rejects non-SVG roots and entity declarations", () => {
  expect(sanitizeSvgMarkup("<html><svg></svg></html>")).toBeNull();
  expect(sanitizeSvgMarkup('<!DOCTYPE svg [<!ENTITY x "boom">]><svg>&x;</svg>')).toBeNull();
});

test("Markdown images render raster-only URLs and reject SVG or script schemes", () => {
  const target = document.createElement("div");
  const gif = "R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  const percentGif = [...atob(gif)]
    .map((byte) => `%${byte.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .join("");
  appendRichContent(
    target,
    `![pixel](data:image/gif;base64,${gif}) ![percent](data:image/gif,${percentGif}) ![remote](https://images.invalid/pixel.png) ![svg](https://attacker.invalid/payload.svg) ![inline svg](data:image/svg+xml,%3Csvg%3E) ![script](javascript:alert(1))`,
    appendPlain,
  );
  const images = target.querySelectorAll("img");
  expect(images).toHaveLength(3);
  expect(images[0].getAttribute("src")).toBe(`data:image/gif;base64,${gif}`);
  expect(images[0].getAttribute("loading")).toBe("lazy");
  expect(images[1].getAttribute("src")).toBe(`data:image/gif,${percentGif}`);
  expect(images[2].getAttribute("src")).toBe("https://images.invalid/pixel.png");
  expect(target.textContent).toContain("![svg]");
  expect(target.textContent).toContain("![script]");
});

test("inline math uses bundled KaTeX HTML and MathML output", async () => {
  const target = document.createElement("div");
  appendRichContent(target, "The value is $\\frac{a_1}{b_2}$.", appendPlain);
  await import("./rich-katex");
  expect(target.querySelector(".katex")).not.toBeNull();
  expect(target.querySelector("math")).not.toBeNull();
  expect(document.querySelector("style[data-omp-katex]")?.textContent).toContain("/vendor/katex/fonts/");
});
test("inline math and raster images render inside Markdown table cells", async () => {
  const target = document.createElement("div");
  const gif = "R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";
  const markdown = [
    "| Expression | Preview |",
    "| --- | --- |",
    `| $x^2$ | ![pixel](data:image/gif;base64,${gif}) |`,
  ].join("\n");
  appendRichContent(target, markdown, (parent, text) => {
    if (!text.startsWith("| Expression |")) {
      appendPlain(parent, text);
      return;
    }
    const wrapper = document.createElement("div");
    const table = document.createElement("table");
    const body = document.createElement("tbody");
    for (const [index, line] of text.split("\n").entries()) {
      if (index === 1) continue;
      const row = document.createElement("tr");
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
      for (const source of cells) {
        const cell = document.createElement("td");
        cell.textContent = source.trim();
        row.append(cell);
      }
      body.append(row);
    }
    table.append(body);
    wrapper.append(table);
    parent.append(wrapper);
  });
  await Promise.all([import("./rich-katex"), import("./rich-chart")]);
  expect(target.querySelector("td .katex")).not.toBeNull();
  expect(target.querySelector("td img.rich-image-view")?.getAttribute("src")).toBe(`data:image/gif;base64,${gif}`);
});

test("single-dollar currency ranges remain literal text", () => {
  const target = document.createElement("div");
  const prices = "Plans cost $5/day-$10/day.";
  appendRichContent(target, prices, appendPlain);
  expect(target.textContent).toBe(prices);
  expect(target.querySelector(".katex")).toBeNull();
});
test("numeric Markdown tables retain their table and get a safe chart figure", async () => {
  const target = document.createElement("div");
  const markdown = [
    "| Segment | Requests |",
    "| --- | ---: |",
    "| Alpha | 1 |",
    "| Beta | 2 |",
    "| Gamma | 3 |",
    "| Delta | 4 |",
  ].join("\n");
  appendRichContent(target, `${markdown}\n\nAfter chart`, (parent, text) => {
    const block = document.createElement("div");
    if (text === markdown) block.append(document.createElement("table"));
    else block.textContent = text;
    parent.append(block);
  });
  await import("./rich-chart");
  const chart = target.querySelector<HTMLImageElement>(".rich-chart-wrap .rich-svg-view");
  expect(chart).not.toBeNull();
  expect(chart?.alt).toContain("Segment");
  expect(chart?.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
  const source = decodeURIComponent(chart?.getAttribute("src")?.split(",", 2)[1] ?? "");
  expect(source).toContain("<svg");
  expect(source).toContain("viewBox=");
  expect(source).toContain("Alpha");
  expect(source).toContain("Delta");
  expect(source).not.toMatch(/<script|foreignObject|(?:href|url)\s*=\s*["'](?:https?:|\/\/)|javascript:/i);
  expect(target.querySelector(".rich-source")?.textContent).toBe(markdown);
  expect(target.querySelector(".rich-source-toggle")).not.toBeNull();
  expect(target.querySelector("table")).not.toBeNull();
  expect(chart?.closest(".rich-chart-wrap")?.nextElementSibling?.textContent).toContain("After chart");
});
