// Run: bunx playwright install chromium && bun run scripts/composer-selection.browser.ts
// Real Chromium is required: happy-dom does not reproduce innerText's caret reset.
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
const source = await Bun.file(new URL("../src/client.ts", import.meta.url)).text();
const transpiler = new Bun.Transpiler({ loader: "ts" });
const extract = (name: string) => {
  const start = source.indexOf(`function ${name}(`);
  return start < 0 ? "" : transpiler.transformSync(source.slice(start).split("\n}\n")[0] + "\n}");
};
const browser = await chromium.launch({ headless: true });
let failures = 0;
try {
  for (const [name, argument, expected] of [
    ["selectCommand", { name: "help" }, "/help"],
    ["applyMoveSelection", "/tmp/project", "/move /tmp/project"],
    ["selectDirectory", "/tmp/project", "/move /tmp/project"],
  ] as const) {
    const page = await browser.newPage();
    await page.setContent('<div id="prompt" contenteditable="true">/m</div>');
    await page.locator("#prompt").focus();
    await page.keyboard.press("End");
    const code = `const drafts = new Map(), draftStore = new Map(), slots = [];
      let activeId = 'test', dismissedCommandDraft, dismissedMoveDraft, commandSelection;
      const requiredElement = () => document.querySelector('#prompt');
      const resizePrompt = () => {}, renderCommandMenu = () => {}, closeModal = () => {};
      ${extract("storeDraft")}
      ${extract("focusPromptEnd")}
      ${extract(name)}; ${name}(${JSON.stringify(argument)});
      if (drafts.get(activeId) !== ${JSON.stringify(expected)} ||
          draftStore.get('runtime:' + activeId) !== ${JSON.stringify(expected)}) {
        throw new Error('Completion did not store its draft');
      }`;
    await page.evaluate(code);
    await page.keyboard.type("X");
    const actual = await page.locator("#prompt").innerText();
    try { assert.equal(actual, expected + "X"); console.log(`PASS ${name}: ${actual}`); }
    catch (error) { failures++; console.error(`FAIL ${name}: ${actual}; expected ${expected}X`); }
    await page.close();
  }
  const css = await Bun.file(new URL("../public/styles.css", import.meta.url)).text();
  const layoutHtml = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>
    <div class="app-shell"><div class="composer-dock"><form class="composer"><div class="composer-tools">
      <button class="ghost-btn attach-btn" id="attach-images">＋</button>
      <div class="composer-meta"><button class="ghost-btn" id="model-open"></button>
        <button class="ghost-btn" id="effort-open">Effort</button><span id="ctx-label"></span><span id="cost-label"></span></div>
      <button class="send-btn" id="send">Send</button>
    </div></form></div></div>`;
  const layoutPage = await browser.newPage({ viewport: { width: 320, height: 720 } });
  try {
    await layoutPage.setContent(layoutHtml);
    for (const width of [320, 375, 768]) {
      await layoutPage.setViewportSize({ width, height: 720 });
      const code = `(() => {
        ${extract("formatModelLabel")}
        const button = document.querySelector("#model-open");
        if (!(button instanceof HTMLButtonElement)) throw new Error("model button missing");
        button.textContent = formatModelLabel("anthropic/claude-opus-4.1-20250805", true);
        button.title = "Model · Fast mode";
        const text = button.firstChild;
        const index = text.textContent.indexOf("⚡");
        const range = document.createRange();
        range.setStart(text, index); range.setEnd(text, index + 1);
        const marker = range.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return { markerVisible: marker.left >= bounds.left && marker.right <= bounds.right,
          scrollWidth: button.scrollWidth, clientWidth: button.clientWidth,
          title: button.title, label: button.textContent };
      })()`;
      const result = await layoutPage.evaluate<{
        markerVisible: boolean;
        scrollWidth: number;
        clientWidth: number;
        title: string;
        label: string;
      }>(code);
      assert.equal(result.markerVisible, true, `fast-mode marker must remain visible at ${width}px`);
      assert.equal(result.title, "Model · Fast mode");
      if (width <= 375) assert.ok(result.scrollWidth > result.clientWidth, "long model name must exercise ellipsis");
      console.log(`PASS fast-mode marker at ${width}px: ${result.label}`);
    }
  } finally { await layoutPage.close(); }
} finally { await browser.close(); }
assert.equal(failures, 0, "completion typing must append at the caret");
