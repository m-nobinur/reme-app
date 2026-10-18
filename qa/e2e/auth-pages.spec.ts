import AxeBuilder from "@axe-core/playwright"
import { expect, test } from "@playwright/test"
import { AXE_TAGS } from "./axe"

/**
 * The accessibility scan for the pages a person meets before they have a
 * session, in both themes.
 *
 * The component catalog scans each primitive on its own, which cannot see what
 * a whole page does with them: a heading order, a landmark, a control whose
 * only label is a placeholder. `heading-order` in particular is filed by axe
 * under `best-practice` rather than under any WCAG tag, so a WCAG-only rule set
 * passes a page whose outline jumps h1 to h3. That is how a real defect reached
 * /app/approvals past a green catalog, so `best-practice` is in the tag list
 * here for the same reason it is in smoke.spec.ts.
 *
 * Both themes, because the tokens differ between them and contrast is a token
 * property. A single-theme scan checks half of the colour decisions.
 */

// Reduced motion, so axe measures settled colours: the front page and the
// sign-in panel fade and pop in, and mid-fade text reads as low contrast.
test.use({
  storageState: { cookies: [], origins: [] },
  contextOptions: { reducedMotion: "reduce" },
})

const PAGES = [
  ["the landing page", "/"],
  ["sign in", "/sign-in"],
  ["sign in after a cancelled provider redirect", "/sign-in?error=cancelled"],
  ["sign in with a code", "/sign-in-code"],
  ["sign up", "/sign-up"],
  ["the privacy policy", "/privacy"],
  ["the terms", "/terms"],
  ["forgot password", "/forgot-password"],
  ["a dead reset link", "/reset-password"],
  // Short on purpose. A longer stand-in reads to `.githooks/secret-scan` as a
  // committed token, and it only has to be non-empty for the form to render.
  ["the reset form", "/reset-password?token=probe"],
] as const

for (const theme of ["light", "dark"] as const) {
  for (const [name, path] of PAGES) {
    test(`${name} has no accessibility violations in ${theme}`, async ({
      page,
    }) => {
      // The same switch a person uses, set before the first paint so the
      // blocking init script in <head> reads it.
      await page.addInitScript(
        `try{localStorage.setItem("reme-theme",${JSON.stringify(theme)})}catch(e){}`
      )
      await page.goto(path)
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible()

      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .analyze()

      expect(
        results.violations.map((violation) => violation.id),
        JSON.stringify(results.violations, null, 2)
      ).toEqual([])
    })
  }
}
