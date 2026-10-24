// Run: bunx playwright install chromium && bun run scripts/composer-selection.browser.ts
// Real Chromium is required: happy-dom does not reproduce innerText's caret reset.
import { chromium } from "playwright";
import { strict as assert } from "node:assert";
const source = await Bun.file(new URL("../client.ts", import.meta.url)).text();
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
} finally { await browser.close(); }
assert.equal(failures, 0, "completion typing must append at the caret");
