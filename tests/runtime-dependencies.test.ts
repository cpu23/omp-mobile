import { expect, test } from "bun:test";

const manifest = JSON.parse(
  await Bun.file(new URL("../package.json", import.meta.url)).text(),
) as { dependencies?: Record<string, string> };

test("declares the directly imported model-tier helper as a production dependency", () => {
  expect(manifest.dependencies?.["@oh-my-pi/pi-ai"]).toBe("18.12.1");
});
