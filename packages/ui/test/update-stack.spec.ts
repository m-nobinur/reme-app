import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * A conversation's update stack above the composer, in each journey state:
 * which item is in front, what waits under it, and that a question card
 * takes the slot. In both themes and at a phone's width.
 */

test.use({ reducedMotion: "reduce" })

const ENTRY = "DockedUpdates"

const STATES = [
  ["never-answered", "Brightclean website", ["Publish", "Connect"]],
  ["skipped", "Brightclean website", ["Publish", "Connect"]],
  [
    "buying-elsewhere",
    "Finished buying sparkleclean.co.uk?",
    ["Connect it", "Publish"],
  ],
  ["bought", "sparkleclean.co.uk is ready to connect", ["Connect", "Publish"]],
  ["google", "Brightclean website", ["Publish", "Connect Search Console"]],
  ["google-done", "Brightclean website", ["Publish"]],
] as const

for (const theme of ["light", "dark"]) {
  for (const width of [1024, 390]) {
    test(`each journey state's stack, ${theme} at ${width} px`, async ({
      page,
    }) => {
      await open(page, ENTRY, width, theme)
      for (const [state, first, actions] of STATES) {
        const stack = page
          .locator(`[data-state="${state}"]`)
          .getByRole("region", { name: "Updates" })
        await expect(stack.locator("[data-front]")).toContainText(first)
        // Each item in turn, by its own action, and only the front one's.
        await expect(stack.getByText(`1/${actions.length}`)).toHaveCount(
          actions.length > 1 ? 1 : 0
        )
        for (const action of actions) {
          const front = stack.locator("[data-front]")
          await expect(
            front.getByRole("button", { name: action, exact: true })
          ).toBeVisible()
          await expect(
            stack.getByRole("button", {
              name: actions.find((other) => other !== action) ?? "none",
              exact: true,
            })
          ).toBeHidden()
          if (actions.length > 1) {
            await stack.getByRole("button", { name: "Next update" }).click()
          }
        }
      }
      // A question that docks takes the slot; the stack waits behind it.
      const asked = page.locator('[data-state="question-open"]')
      await expect(asked.locator('[data-slot="update-stack"]')).toBeHidden()
      await expect(asked).toContainText("1 of 2, also your updates")
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        )
      ).toBe(false)
      await axe(page, `${ENTRY} ${theme} ${width}`)
    })
  }
}
