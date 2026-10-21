import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

// Exercise the real client function without booting the app or opening sockets.
const client = await Bun.file(new URL("./client.ts", import.meta.url)).text();
const start = client.indexOf("async function addImageFiles(");
const end = client.indexOf("async function refreshTerminalControls(", start);
const implementation = new Bun.Transpiler({ loader: "ts" }).transformSync(client.slice(start, end));

for (const limitCase of ["count", "size"] as const) {
  test(`concurrent image additions enforce the latest draft ${limitCase} limit`, async () => {
    const encoded = (data: string) => ({ type: "image", mimeType: "image/jpeg", data });
    const initial = limitCase === "count"
      ? Array.from({ length: 7 }, (_, index) => encoded(`i${index}`))
      : [encoded("x".repeat(3 * 1024 * 1024 - 4))];
    const waiting: Array<(image: ReturnType<typeof encoded>) => void> = [];
    const errors: string[] = [];
    const state = {
      activeId: "a",
      attachedImages: initial,
      attachmentsBySlot: new Map<string, ReturnType<typeof encoded>[]>([["a", initial]]),
      attachmentRevision: 0,
      imageSubmissionIds: new WeakMap(),
      nextImageSubmissionId: 1,
      encodeRasterImage: () => new Promise<ReturnType<typeof encoded>>((resolve) => waiting.push(resolve)),
      renderAttachments: () => {},
      showToast: (message: string) => { errors.push(message); },
      errorMessage: String,
    };
    const addImages = runInNewContext(`${implementation}\naddImageFiles`, state);
    const first = addImages([new File(["a"], "a.png")]);
    const second = addImages([new File(["b"], "b.png")]);
    waiting[0]!(encoded(limitCase === "count" ? "first" : "x".repeat(3)));
    await first;
    waiting[1]!(encoded(limitCase === "count" ? "second" : "y".repeat(3)));
    await second;
    const images = state.attachmentsBySlot.get("a")!;
    expect(images.length).toBeLessThanOrEqual(8);
    expect(images.reduce((total, image) => total + image.data.length, 0)).toBeLessThanOrEqual(3 * 1024 * 1024);
    expect(errors).toHaveLength(1);
  });
}

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
