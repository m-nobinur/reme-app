// No parse5 here: the router reads paths through this file and carries none
// of the content gate's parser (the size gate's `--forbid` checks it).

/**
 * The file a request path names under a revision, or null: only what the
 * manifest lists resolves (`/` to `index.html`, `/contact/` and `/contact` to
 * `contact/index.html`). The links gate, the console preview and the router
 * read paths the same way.
 */
export function resolveSitePath(
  pathname: string,
  files: Record<string, string>
): string | null {
  let path: string
  try {
    path = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (path.includes("\0") || path.split("/").includes("..")) return null
  const trimmed = path.replace(/^\/+/, "")
  const candidates =
    trimmed === "" || trimmed.endsWith("/")
      ? [`${trimmed}index.html`]
      : [trimmed, `${trimmed}/index.html`]
  return candidates.find((file) => Object.hasOwn(files, file)) ?? null
}
