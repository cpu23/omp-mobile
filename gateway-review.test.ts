import { expect, test } from "bun:test";
import { normaliseState } from "./server";

test("gateway preserves the bridge's complete executable review and title", () => {
  const body = "Detailed plan\n".repeat(2000) + "FINAL SAFETY CONDITION";
  const title = "t".repeat(256);
  const state = normaliseState({ generation: "g", runtime: { notices: [], interaction: {
    id: "review", kind: "plan", title, body,
    options: [{ id: "execute", label: "Execute" }], transport: "native", createdAt: 1,
  } } });
  expect(state?.runtime?.interaction?.title).toBe(title);
  expect(state?.runtime?.interaction?.body).toBe(body);
});
