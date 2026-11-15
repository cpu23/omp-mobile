import katex from "katex";
// Bun emits this stylesheet with the KaTeX chunk instead of the core client.
// @ts-expect-error CSS is loaded with Bun's text import loader for the browser bundle.
import katexCssText from "katex/dist/katex.min.css" with { type: "text" };

let stylesInstalled = false;

function ensureStyles(): void {
  if (stylesInstalled || document.querySelector("style[data-omp-katex]")) {
    stylesInstalled = true;
    return;
  }
  const style = document.createElement("style");
  style.dataset.ompKatex = "true";
  style.textContent = katexCssText.replace(
    /url\(\s*(["']?)fonts\/([A-Za-z0-9_.-]+\.(?:woff2?|ttf))\1\s*\)/g,
    'url("/vendor/katex/fonts/$2")',
  );
  (document.head ?? document.documentElement).append(style);
  stylesInstalled = true;
}

export function renderKatex(wrapper: HTMLElement, source: string, display: boolean): boolean {
  try {
    katex.render(source, wrapper, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: true,
      strict: "warn",
      trust: false,
      maxExpand: 1_000,
      maxSize: 20,
    });
  } catch {
    return false;
  }
  ensureStyles();
  return true;
}
