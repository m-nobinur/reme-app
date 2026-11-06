import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * A conversation's update stack above the composer, in each journey state:
 * which item is in front, what waits under it, and that a question card
 * takes the slot. In both themes and at a phone's width.
 */

test.use({ reducedMotion: "reduce" })

const ENTRY = "DockedUpdates"

const STATES = [
  ["never-answered", "Brightclean website", ["Publish", "Connect now"]],
  ["skipped", "Brightclean website", ["Publish", "Connect now"]],
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
        // No pager: the front one's action in front, the rest's behind it.
        await expect(stack.getByText(/^\d+\/\d+$/)).toHaveCount(0)
        const [lead, ...others] = actions
        await expect(
          stack
            .locator("[data-front]")
            .getByRole("button", { name: lead, exact: true })
        ).toBeVisible()
        for (const action of others) {
          await expect(
            stack
              .locator('[data-slot="update-deck-rest"]')
              .getByRole("button", { name: action, exact: true })
          ).toHaveCount(1)
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

for (const theme of ["light", "dark"]) {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    test(`quick replies take the stack's place, ${theme}, motion ${reducedMotion}`, async ({
      page,
    }) => {
      await page.emulateMedia({ reducedMotion })
      await open(page, ENTRY, 390, theme)
      const chat = page.locator('[data-state="pills-open"]')
      const pills = chat.getByRole("group", { name: "Quick replies" })
      await expect(
        pills.getByRole("button", { name: "Bought it" })
      ).toBeVisible()
      await expect(chat.locator('[data-slot="update-stack"]')).toBeHidden()
      await expect(
        chat.locator('[data-slot="update-stack"] > [data-away]')
      ).toHaveCount(1)
      await chat.scrollIntoViewIfNeeded()
      await chat.screenshot({
        path: test
          .info()
          .outputPath(`pills-over-stack-390-${theme}-${reducedMotion}.png`),
      })
      // The stack is back where the other states show it.
      await expect(
        page.locator(
          '[data-state="buying-elsewhere"] [data-slot="update-stack"]'
        )
      ).toBeVisible()
      await axe(page, `${ENTRY} pills ${theme}`)
    })
  }
}

/** A new chat's stack under the composer, and the cards spread behind its front one. */
const deck = (page: Page) => page.getByRole("region", { name: "Updates" })
const rest = (page: Page) =>
  deck(page).locator('[data-slot="update-deck-rest"]')
const scroller = (page: Page) => rest(page).locator("> div")

/** How many cards show at least half of themselves: the front one, and those the spread's scroll shows. */
const inView = async (page: Page) => {
  if (
    (await rest(page).evaluate((node) => getComputedStyle(node).opacity)) ===
    "0"
  ) {
    return 1
  }
  const behind = await scroller(page).evaluate((list) => {
    const clip = list.getBoundingClientRect()
    return [...list.children].filter((card) => {
      const box = card.getBoundingClientRect()
      const shown =
        Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top)
      return shown >= box.height / 2
    }).length
  })
  return 1 + behind
}

test("at rest the stack is its front card with edges under it, and no pager", async ({
  page,
}) => {
  await open(page, "UpdateDeck", 390)
  await expect(deck(page).locator("[data-front]")).toContainText(
    "Brightclean website"
  )
  await expect(deck(page).getByText(/^\d+\/\d+$/)).toHaveCount(0)
  await expect(deck(page)).not.toHaveAttribute("data-open")
  await expect(rest(page)).toHaveCSS("opacity", "0")
  await expect(rest(page)).toHaveCSS("pointer-events", "none")
  expect(await inView(page)).toBe(1)
})

test("pointing at the stack spreads four cards, scrolls the rest, and folds when the pointer leaves", async ({
  page,
}) => {
  await open(page, "UpdateDeck", 390)
  await deck(page).locator("[data-front]").hover()
  await expect(deck(page)).toHaveAttribute("data-open", "true")
  await expect(rest(page)).toHaveCSS("opacity", "1")
  // Spread below the front card, over the page rather than pushing it.
  const front = await deck(page).locator("[data-front]").boundingBox()
  const spread = await rest(page).boundingBox()
  expect(spread?.y ?? 0).toBeGreaterThanOrEqual(
    (front?.y ?? 0) + (front?.height ?? 0)
  )
  expect(await inView(page)).toBe(4)
  // Five behind the front one: more than the spread holds, so it scrolls.
  expect(
    await scroller(page).evaluate(
      (node) => node.scrollHeight > node.clientHeight
    )
  ).toBe(true)
  await scroller(page).hover()
  await page.mouse.wheel(0, 400)
  await expect(
    deck(page).getByText("Can you send photos of your team?")
  ).toBeInViewport()
  await expect(deck(page)).toHaveAttribute("data-open", "true")
  // Gone from the stack, it folds.
  await page.mouse.move(5, 5)
  await expect(deck(page)).not.toHaveAttribute("data-open")
  await expect(rest(page)).toHaveCSS("opacity", "0")
})

test("tabbing into the stack spreads it, reaches every card, and folds once focus leaves", async ({
  page,
}) => {
  await open(page, "UpdateDeck", 390)
  await page.getByLabel("Message input").focus()
  const within = () =>
    deck(page).evaluate((node) => node.contains(document.activeElement))
  for (let press = 0; press < 12 && !(await within()); press++) {
    await page.keyboard.press("Tab")
  }
  await expect(deck(page)).toHaveAttribute("data-open", "true")
  // The cards behind are in the tab order: the last one's Answer, scrolled to.
  const last = deck(page)
    .getByRole("button", { name: "Answer", exact: true })
    .last()
  const onLast = () => last.evaluate((node) => node === document.activeElement)
  for (let press = 0; press < 12 && !(await onLast()); press++) {
    await page.keyboard.press("Tab")
  }
  await expect(last).toBeFocused()
  await expect(last).toBeInViewport()
  await page.keyboard.press("Tab")
  await expect(deck(page)).not.toHaveAttribute("data-open")
})

test("a click inside keeps the stack open only while the pointer is on it", async ({
  page,
}) => {
  await open(page, "UpdateDeck", 390)
  await deck(page).locator("[data-front]").hover()
  await deck(page)
    .getByRole("button", { name: "Answer", exact: true })
    .first()
    .click()
  await page.mouse.move(5, 5)
  await expect(deck(page)).not.toHaveAttribute("data-open")
})

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true })

  test("a tap spreads the stack and a tap elsewhere folds it", async ({
    page,
  }) => {
    await open(page, "UpdateDeck", 390)
    const heading = page.getByRole("heading", {
      name: "What should we do today?",
    })
    await deck(page).getByText("Brightclean website").tap()
    await expect(deck(page)).toHaveAttribute("data-open", "true")
    await expect(rest(page)).toHaveCSS("opacity", "1")
    await heading.tap()
    await expect(deck(page)).not.toHaveAttribute("data-open")
  })
})

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`the spread moves only with motion allowed, motion ${reducedMotion}`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion })
    await open(page, "UpdateDeck", 390)
    const style = await rest(page).evaluate((node) => {
      const { translate, transitionDuration } = getComputedStyle(node)
      return { translate, transitionDuration }
    })
    expect(style).toEqual(
      reducedMotion === "reduce"
        ? { translate: "none", transitionDuration: "0s" }
        : { translate: "0px -8px", transitionDuration: "0.25s" }
    )
  })
}

test("above the composer the stack spreads upwards", async ({ page }) => {
  await open(page, ENTRY, 390)
  const stack = page
    .locator('[data-state="buying-elsewhere"]')
    .getByRole("region", { name: "Updates" })
  await stack.locator("[data-front]").hover()
  await expect(stack).toHaveAttribute("data-open", "true")
  const front = await stack.locator("[data-front]").boundingBox()
  const spread = await stack
    .locator('[data-slot="update-deck-rest"]')
    .boundingBox()
  expect((spread?.y ?? 0) + (spread?.height ?? 0)).toBeLessThanOrEqual(
    front?.y ?? 0
  )
  await expect(
    stack.getByRole("button", { name: "Publish", exact: true })
  ).toBeInViewport()
})

for (const theme of ["light", "dark"]) {
  for (const entry of ["UpdateDeck", "UpdateDeck open"]) {
    test(`${entry}, ${theme} at 390 px`, async ({ page }) => {
      await open(page, entry, 390, theme)
      if (entry === "UpdateDeck open") {
        await expect(deck(page)).toHaveAttribute("data-open", "true")
      } else {
        await expect(deck(page)).not.toHaveAttribute("data-open")
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth
        )
      ).toBe(false)
      await page.locator(`[data-entry="${entry}"]`).screenshot({
        path: test.info().outputPath(`${entry}-390-${theme}.png`),
      })
      await axe(page, `${entry} ${theme}`)
    })
  }
}
