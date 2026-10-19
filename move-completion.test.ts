import { describe, expect, test } from "bun:test";
import {
  buildMoveCompletion,
  directorySuggestions,
  moveContextKey,
  resolveMoveCandidate,
  selectedMovePath,
  splitMoveCandidate,
  type MoveCompletion,
  type MoveListing,
} from "./move-completion";
import type { DirectoryListing } from "./shared";

/**
 * `/move` completion resolves a draft against one session cwd and hands the
 * send path back through {@link selectedMovePath}. These vectors pin the
 * regression where a cached completion from a previous session or cwd kept its
 * absolute `resolvedPath`, so `/move` after a cwd change submitted a directory
 * from the old working directory.
 */

function listing(
  path: string,
  entries: Array<[string, "directory" | "file"]>,
): DirectoryListing {
  const prefix = path === "/" ? "" : path.replace(/\/+$/, "");
  return {
    path,
    root: "/",
    parent: "/",
    entries: entries.map(([name, kind]) => ({
      name,
      path: `${prefix}/${name}`,
      kind,
    })),
  };
}

function fixtureFetcher(
  listings: Record<string, DirectoryListing>,
  errors: Record<string, string> = {},
): {
  calls: string[];
  fetchListing: (path?: string) => Promise<MoveListing>;
} {
  const calls: string[] = [];
  return {
    calls,
    fetchListing: async (path?: string) => {
      const key = path ?? "/";
      calls.push(key);
      const error = errors[key];
      if (error) return { listing: null, error };
      const value = listings[key];
      return value
        ? { listing: value, error: null }
        : { listing: null, error: "Directory unavailable" };
    },
  };
}

const LISTINGS: Record<string, DirectoryListing> = {
  "/": listing("/", [
    ["beta", "directory"],
    ["Alpha", "directory"],
    ["notes.txt", "file"],
  ]),
  "/work": listing("/work", [
    ["src", "directory"],
    ["README.md", "file"],
  ]),
  "/work/src": listing("/work/src", [["client", "directory"]]),
};

describe("moveContextKey", () => {
  test("separates sessions and working directories", () => {
    expect(moveContextKey("rt-a", "/work")).not.toBe(
      moveContextKey("rt-b", "/work"),
    );
    expect(moveContextKey("rt-a", "/work")).not.toBe(
      moveContextKey("rt-a", "/work/src"),
    );
  });

  test("normalizes separators and treats a non-absolute cwd as unknown", () => {
    expect(moveContextKey("rt-a", "/work\\src")).toBe(
      moveContextKey("rt-a", "/work/src"),
    );
    expect(moveContextKey("rt-a", "work")).toBe(
      moveContextKey("rt-a", undefined),
    );
  });
});

describe("buildMoveCompletion", () => {
  test("lists the workspace root for an empty draft", async () => {
    const { fetchListing } = fixtureFetcher(LISTINGS);
    const completion = await buildMoveCompletion("", "/work", fetchListing);
    expect(completion.resolvedPath).toBeNull();
    expect(completion.suggestions).toEqual([
      { name: "Alpha", path: "/Alpha" },
      { name: "beta", path: "/beta" },
    ]);
  });

  test("resolves a relative draft against the session cwd", async () => {
    const { fetchListing, calls } = fixtureFetcher(LISTINGS);
    const completion = await buildMoveCompletion("src", "/work", fetchListing);
    expect(calls).toEqual(["/work", "/work/src"]);
    expect(completion.resolvedPath).toBe("/work/src");
    expect(completion.suggestions).toEqual([
      { name: "client", path: "/work/src/client" },
    ]);
  });

  test("a trailing slash lists that directory without re-resolving it", async () => {
    const { fetchListing, calls } = fixtureFetcher(LISTINGS);
    const completion = await buildMoveCompletion("src/", "/work", fetchListing);
    expect(calls).toEqual(["/work/src"]);
    expect(completion.resolvedPath).toBe("/work/src");
    expect(completion.suggestions).toEqual([
      { name: "client", path: "/work/src/client" },
    ]);
  });

  test("a partial name filters the parent listing", async () => {
    const { fetchListing, calls } = fixtureFetcher(LISTINGS);
    const completion = await buildMoveCompletion("sr", "/work", fetchListing);
    expect(calls).toEqual(["/work"]);
    expect(completion.resolvedPath).toBeNull();
    expect(completion.suggestions).toEqual([{ name: "src", path: "/work/src" }]);
  });

  test("surfaces listing errors", async () => {
    const { fetchListing } = fixtureFetcher(LISTINGS, {
      "/work": "Directory unavailable",
    });
    const completion = await buildMoveCompletion("src", "/work", fetchListing);
    expect(completion).toEqual({
      resolvedPath: null,
      suggestions: [],
      error: "Directory unavailable",
    });
  });

  test("an empty draft lists the workspace root instead of the session cwd", async () => {
    const { fetchListing, calls } = fixtureFetcher(LISTINGS);
    const completion = await buildMoveCompletion("", "/work", fetchListing);
    expect(calls).toEqual(["/"]);
    expect(completion.resolvedPath).toBeNull();
    expect(completion.suggestions.map((entry) => entry.path)).toEqual([
      "/Alpha",
      "/beta",
    ]);
  });

  test("retries the root listing once, then reports the failure", async () => {
    const { fetchListing, calls } = fixtureFetcher(LISTINGS, {
      "/": "Directory unavailable",
    });
    const completion = await buildMoveCompletion("", "/work", fetchListing);
    expect(calls).toEqual(["/", "/"]);
    expect(completion).toEqual({
      resolvedPath: null,
      suggestions: [],
      error: "Directory unavailable",
    });
  });
});

describe("selectedMovePath", () => {
  function completionFor(context: string): MoveCompletion {
    return {
      context,
      draft: "src",
      resolvedPath: "/work/src",
      suggestions: [
        { name: "other", path: "/work/other" },
        { name: "src", path: "/work/src" },
      ],
      loading: false,
      error: null,
    };
  }

  test("uses the resolved path for the matching context", () => {
    const context = moveContextKey("rt-a", "/work");
    expect(selectedMovePath(completionFor(context), context, "src", 1)).toBe(
      "/work/src",
    );
  });

  test("ignores a completion from another session or cwd", () => {
    const stale = completionFor(moveContextKey("rt-a", "/work"));
    const current = moveContextKey("rt-a", "/work/src");
    expect(selectedMovePath(stale, current, "src", 1)).toBe("src");
    expect(
      selectedMovePath(
        completionFor(moveContextKey("rt-b", "/work")),
        moveContextKey("rt-a", "/work"),
        "src",
        1,
      ),
    ).toBe("src");
  });

  test("falls back to the highlighted suggestion, then the raw text", () => {
    const context = moveContextKey("rt-a", "/work");
    const open: MoveCompletion = {
      ...completionFor(context),
      resolvedPath: null,
    };
    expect(selectedMovePath(open, context, "src", 1)).toBe("/work/src");
    expect(selectedMovePath(open, context, "src", 9)).toBe("src");
    expect(selectedMovePath(open, context, "other", 1)).toBe("other");
  });

  test("a stale completion resolves against the current cwd instead", () => {
    const stale = completionFor(moveContextKey("rt-a", "/old"));
    const current = moveContextKey("rt-a", "/new/cwd");
    const chosen = resolveMoveCandidate(
      selectedMovePath(stale, current, "src", 0),
      "/new/cwd",
    );
    expect(chosen).toBe("/new/cwd/src");
  });
});

describe("pure resolution helpers", () => {
  test("absolute, home and empty drafts pass through unresolved", () => {
    expect(resolveMoveCandidate("/abs", "/work")).toBe("/abs");
    expect(resolveMoveCandidate("~/abs", "/work")).toBe("~/abs");
    expect(resolveMoveCandidate("", "/work")).toBe("");
    expect(resolveMoveCandidate("src", undefined)).toBe("src");
    expect(resolveMoveCandidate("src", "/work/")).toBe("/work/src");
  });

  test("splitting keeps the leaf fragment for filtering", () => {
    expect(splitMoveCandidate("/work/src", "src")).toEqual({
      parent: "/work",
      partial: "src",
      exact: false,
    });
    expect(splitMoveCandidate("/work/src/", "src/")).toEqual({
      parent: "/work/src",
      partial: "",
      exact: true,
    });
    expect(splitMoveCandidate("", "")).toEqual({
      parent: "",
      partial: "",
      exact: true,
    });
  });

  test("directory suggestions drop files and sort case-insensitively", () => {
    expect(directorySuggestions(LISTINGS["/"] as DirectoryListing)).toEqual([
      { name: "Alpha", path: "/Alpha" },
      { name: "beta", path: "/beta" },
    ]);
  });
});
