import type { DirectoryListing } from "./shared";

/**
 * `/move` destination completion shared by the browser client and its tests.
 * The client keeps the DOM, debounce and session state; this module owns the
 * resolution rules so they can be exercised without a browser.
 */

export type MoveSuggestion = { name: string; path: string };

export type MoveCompletion = {
  /**
   * Identity of the session/cwd this listing was resolved against. A
   * completion whose context no longer matches the active session is stale:
   * its absolute `resolvedPath` and suggestion paths point inside another
   * working directory and must not be listed or submitted.
   */
  context: string;
  /** Exact text after `/move` this data describes. */
  draft: string;
  /** Directory the typed text resolves to, when it is one. */
  resolvedPath: string | null;
  suggestions: MoveSuggestion[];
  loading: boolean;
  error: string | null;
};

/** Outcome of one directory listing request. */
export type MoveListing = {
  listing: DirectoryListing | null;
  error: string | null;
};

/** The desktop overlay renders at most 20 matches; keep mobile equally bounded. */
export const MOVE_SUGGESTION_LIMIT = 20;

/**
 * Session identity a `/move` completion resolves against: the runtime id plus
 * its normalized cwd. Switching slots or changing the session working
 * directory changes the identity, so completions built for one context are
 * never reused in another.
 */
export function moveContextKey(slotId: string, cwd: unknown): string {
  return `${slotId}\u0000${moveBasePath(cwd) ?? ""}`;
}

/** Session cwd is the base for relative `/move` paths, as in the desktop overlay. */
export function moveBasePath(cwd: unknown): string | undefined {
  return typeof cwd === "string" && cwd.startsWith("/")
    ? cwd.replace(/\\/g, "/")
    : undefined;
}

export function resolveMoveCandidate(
  input: string,
  base: string | undefined,
): string {
  const normalized = input.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("~") ||
    !base
  )
    return normalized;
  return `${base.replace(/\/+$/, "")}/${normalized}`;
}

/**
 * Split typed text into the directory to list and the leaf fragment to match.
 * A trailing slash means "list this directory"; otherwise the fragment is
 * filtered inside its parent, matching the desktop /move overlay.
 */
export function splitMoveCandidate(
  candidate: string,
  input: string,
): { parent: string; partial: string; exact: boolean } {
  if (!input) return { parent: candidate, partial: "", exact: true };
  if (candidate === "~") return { parent: "~", partial: "", exact: true };
  if (candidate.endsWith("/"))
    return {
      parent: candidate.replace(/\/+$/, "") || "/",
      partial: "",
      exact: true,
    };
  const slash = candidate.lastIndexOf("/");
  if (slash === -1) return { parent: "", partial: candidate, exact: false };
  return {
    parent: candidate.slice(0, slash) || "/",
    partial: candidate.slice(slash + 1),
    exact: false,
  };
}

export function directorySuggestions(
  listing: DirectoryListing,
): MoveSuggestion[] {
  return listing.entries
    .filter((entry) => (entry.kind ?? "directory") === "directory")
    .map((entry) => ({ name: entry.name, path: entry.path }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
}

/**
 * The path a move submission should use: an exact typed directory first, then
 * the highlighted suggestion (desktop's Enter behavior), then the raw text for
 * server-side validation and diagnostics. A completion built for another
 * session/cwd is ignored, so a stale absolute path is never sent.
 */
export function selectedMovePath(
  completion: MoveCompletion | null,
  context: string,
  rawPath: string,
  selection: number,
): string {
  if (
    !completion ||
    completion.context !== context ||
    completion.draft !== rawPath
  )
    return rawPath;
  if (completion.resolvedPath) return completion.resolvedPath;
  return completion.suggestions[selection]?.path ?? rawPath;
}

/**
 * Resolve one `/move` draft against `base`, using `fetchListing` for directory
 * reads. `base` is passed in (never read from global state) so a completion is
 * always the product of one session/cwd identity.
 */
export async function buildMoveCompletion(
  draft: string,
  base: string | undefined,
  fetchListing: (path?: string) => Promise<MoveListing>,
): Promise<Omit<MoveCompletion, "context" | "draft" | "loading">> {
  const input = draft.trim().replace(/\\/g, "/");
  const candidate = resolveMoveCandidate(input, base);
  const { parent, partial, exact } = splitMoveCandidate(candidate, input);
  let fetched = await fetchListing(parent || undefined);
  // An empty `/move` should still offer choices when the session cwd sits
  // outside OMP_MOBILE_ROOT: fall back to the workspace root.
  if (!fetched.listing && !input && base) fetched = await fetchListing();
  const listing = fetched.listing;
  if (!listing)
    return {
      resolvedPath: null,
      suggestions: [],
      error: fetched.error ?? "Directory unavailable",
    };

  const directories = directorySuggestions(listing);
  if (exact)
    return {
      resolvedPath: input ? listing.path : null,
      suggestions: directories.slice(0, MOVE_SUGGESTION_LIMIT),
      error: null,
    };

  const exactEntry = directories.find((entry) => entry.name === partial);
  if (exactEntry) {
    const child = await fetchListing(exactEntry.path);
    return {
      resolvedPath: exactEntry.path,
      suggestions: child.listing
        ? directorySuggestions(child.listing).slice(0, MOVE_SUGGESTION_LIMIT)
        : [],
      error: child.listing ? null : child.error,
    };
  }

  const query = partial.toLowerCase();
  return {
    resolvedPath: null,
    suggestions: (query
      ? directories.filter((entry) =>
          entry.name.toLowerCase().includes(query),
        )
      : directories
    ).slice(0, MOVE_SUGGESTION_LIMIT),
    error: null,
  };
}
