import { z } from "astro/zod"
import { PageDocument } from "./page-document"
import { documentPath, type Page, seedDocuments, withSeed } from "./page-seed"
import { site } from "./site-config"

/**
 * Every page's document, read and checked at build: src/content/pages/<page>.json
 * (services/<slug>.json for a service), or the seed for a page with none. A
 * file that is not a page document fails the build with what is wrong.
 */

const FILES = import.meta.glob<unknown>("./content/pages/**/*.json", {
  eager: true,
  import: "default",
})
const DIR = "./content/pages/"
const hasAbout = Object.keys(import.meta.glob("./pages/about.astro")).length > 0

const seed = seedDocuments(site, undefined, hasAbout)

const documents: Record<string, PageDocument> = { ...seed }
for (const [file, data] of Object.entries(FILES)) {
  const path = file.slice(DIR.length)
  const parsed = PageDocument.safeParse(data)
  if (!parsed.success)
    throw new Error(
      `src/content/pages/${path} is not a page document:\n${z.prettifyError(parsed.error)}`
    )
  documents[path] = withSeed(parsed.data, seed[path])
}

/** A page's document; a service page with neither a file nor a seed has none. */
export const pageDocument = (
  page: Page,
  slug?: string
): PageDocument | undefined => documents[documentPath(page, slug)]

/** Every question a document's FAQ blocks hold, in order, for FAQPage. */
export const faqsOf = (doc: PageDocument | undefined) =>
  (doc?.sections ?? []).flatMap((section) =>
    (section.blocks ?? []).flatMap((block) =>
      block.type === "faq"
        ? block.items.filter((item) => item.question && item.answer)
        : []
    )
  )
