import { site } from "./site-config"

/** The typical-scope note, said once a page: the first trade text to ask for it gets it. */
export function typicalNote(locals: object): string {
  const page = locals as { typicalNoted?: boolean }
  if (page.typicalNoted) return ""
  page.typicalNoted = true
  return site.typicalNote
}
