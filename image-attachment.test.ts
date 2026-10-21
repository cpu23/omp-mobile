import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

// Exercise the real client function without booting the app or opening sockets.
const client = await Bun.file(new URL("./client.ts", import.meta.url)).text();
const start = client.indexOf("async function addImageFiles(");
const end = client.indexOf("async function refreshTerminalControls(", start);
const implementation = new Bun.Transpiler({ loader: "ts" }).transformSync(client.slice(start, end));

for (const switchBack of [false, true]) {
  test(`image encoding preserves the originating session draft${switchBack ? " after switching back" : " while another session is active"}`, async () => {
    const original = { type: "image", mimeType: "image/jpeg", data: "original" };
    const other = { type: "image", mimeType: "image/jpeg", data: "other" };
    const encoded = { type: "image", mimeType: "image/jpeg", data: "encoded" };
    let finish!: (image: typeof encoded) => void;
    const encoding = new Promise<typeof encoded>((resolve) => { finish = resolve; });
    const state = {
      activeId: "a",
      attachedImages: [original],
      attachmentsBySlot: new Map<string, typeof encoded[]>(),
      attachmentRevision: 0,
      imageSubmissionIds: new WeakMap(),
      nextImageSubmissionId: 1,
      encodeRasterImage: () => encoding,
      renderAttachments: () => {},
      showToast: (message: string) => { throw new Error(message); },
      errorMessage: String,
    };
    const addImages = runInNewContext(`${implementation}\naddImageFiles`, state);
    const pending = addImages([new File(["image"], "large.png")]);
    state.attachmentsBySlot.set("a", state.attachedImages);
    state.activeId = "b";
    state.attachedImages = [other];
    state.attachmentsBySlot.set("b", state.attachedImages);
    if (switchBack) {
      state.activeId = "a";
      state.attachedImages = state.attachmentsBySlot.get("a")!;
    }
    finish(encoded);
    await pending;
    expect(state.attachmentsBySlot.get("b")).toEqual([other]);
    expect(state.attachmentsBySlot.get("a")).toEqual([original, encoded]);
    expect(state.attachedImages).toEqual(switchBack ? [original, encoded] : [other]);
    expect(state.attachmentRevision).toBe(switchBack ? 1 : 0);
    expect(state.imageSubmissionIds.has(encoded)).toBe(true);
  });
}
