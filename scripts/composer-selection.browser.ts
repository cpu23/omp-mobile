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
        ${extract("sendButtonIconMarkup")}
        const button = document.querySelector("#model-open");
        const sendButton = document.querySelector("#send");
        if (!(button instanceof HTMLButtonElement) || !(sendButton instanceof HTMLButtonElement))
          throw new Error("composer controls missing");
        const model = "anthropic/claude-opus-4.1-20250805";
        const renderModel = (fastMode) => {
          button.textContent = formatModelLabel(model, fastMode);
          button.title = fastMode ? "Model · Fast mode" : "Model";
        };
        const markerVisible = () => {
          const text = button.firstChild;
          const index = text.textContent.indexOf("⚡");
          if (index < 0) return false;
          const range = document.createRange();
          range.setStart(text, index); range.setEnd(text, index + 1);
          const marker = range.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          return marker.left >= bounds.left && marker.right <= bounds.right;
        };
        renderModel(true);
        const enabled = { markerVisible: markerVisible(), title: button.title,
          label: button.textContent, scrollWidth: button.scrollWidth,
          clientWidth: button.clientWidth };
        renderModel(false);
        const disabled = { hasMarker: button.textContent.includes("⚡"), title: button.title,
          label: button.textContent };
        renderModel(true);
        const reenabled = button.textContent.includes("⚡") && button.title === "Model · Fast mode";
        sendButton.innerHTML = sendButtonIconMarkup(true);
        const forceSendPath = sendButton.querySelector("path")?.getAttribute("d");
        sendButton.innerHTML = sendButtonIconMarkup(false);
        const normalSendPath = sendButton.querySelector("path")?.getAttribute("d");
        return { enabled, disabled, reenabled, forceSendPath, normalSendPath };
      })()`;
      const result = await layoutPage.evaluate<{
        enabled: { markerVisible: boolean; title: string; label: string; scrollWidth: number; clientWidth: number };
        disabled: { hasMarker: boolean; title: string; label: string };
        reenabled: boolean;
        forceSendPath: string | null;
        normalSendPath: string | null;
      }>(code);
      assert.equal(result.enabled.markerVisible, true, `fast-mode marker must remain visible at ${width}px`);
      assert.equal(result.enabled.title, "Model · Fast mode");
      assert.ok(result.enabled.label.includes("⚡"));
      assert.equal(result.disabled.hasMarker, false, "polling fast-mode off must remove the marker");
      assert.equal(result.disabled.title, "Model");
      assert.equal(result.reenabled, true, "polling fast-mode on again must restore the marker");
      if (width <= 375) assert.ok(result.enabled.scrollWidth > result.enabled.clientWidth, "long model name must exercise ellipsis");
      assert.ok(result.forceSendPath?.includes("M8 14V4"), "force-send icon must use upward arrows");
      assert.ok(result.forceSendPath?.includes("M8 18v2m8-16v2"), "force-send arrows must retain trailing marks");
      assert.ok(!result.forceSendPath?.includes("m13 2-8 12"), "force-send icon must not use a bolt");
      assert.ok(result.normalSendPath?.includes("M12 19V5"), "ordinary send icon must remain a single arrow");
      console.log(`PASS fast-mode polling and composer icons at ${width}px: ${result.enabled.label}`);
    }
  } finally { await layoutPage.close(); }
} finally { await browser.close(); }
assert.equal(failures, 0, "completion typing must append at the caret");
