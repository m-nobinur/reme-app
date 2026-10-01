import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * Onboarding's opening message plays in the first time it is seen: the
 * typing dot a reply shows, then the words, then the card. It is never there
 * at first paint, and it is whole well inside two and a half seconds.
 */

const ENTRY = "ThreadReveal"
const OPENING =
  "Hi Sam, I'm Reme. I will set up your website and look after enquiries while you work. To start, what is your business called?"

const root = (page: Page) => page.locator(`[data-entry="${ENTRY}"]`)
const words = (page: Page) => root(page).locator(".aui-md")
const dot = (page: Page) =>
  root(page).locator('[data-slot="aui_assistant-message-indicator"]')
const card = (page: Page) =>
  root(page).getByRole("textbox", { name: "Business name" })

async function play(page: Page) {
  await open(page, ENTRY)
  // Seen before: there at once, nothing played.
  await expect(words(page)).toHaveText(OPENING)
  await root(page).getByRole("button", { name: "Play again" }).click()
}

test("the opening plays in: dot, then words, then the card", async ({
  page,
}) => {
  await play(page)
  // The first paint after it mounts has the dot and none of the words.
  await expect(dot(page)).toBeVisible()
  await expect(words(page)).toHaveCount(0)
  await expect(card(page)).toHaveCount(0)
  // Part way: some words, not all, and still no card.
  await expect(words(page)).not.toHaveText("")
  expect((await words(page).textContent())?.length ?? 0).toBeLessThan(
    OPENING.length
  )
  await expect(card(page)).toHaveCount(0)
  // Whole, with its card, inside 2.5s of the press.
  await expect(words(page)).toHaveText(OPENING, { timeout: 2500 })
  await expect(card(page)).toBeVisible({ timeout: 500 })
})

test("typing in the composer finishes the opening at once", async ({
  page,
}) => {
  await play(page)
  await root(page).getByLabel("Message input").fill("B")
  await expect(words(page)).toHaveText(OPENING, { timeout: 300 })
  await expect(card(page)).toBeVisible()
})

test.describe("with reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } })

  test("the opening shows whole after the dot, never word by word", async ({
    page,
  }) => {
    await play(page)
    await expect(dot(page)).toBeVisible()
    // The first text that appears is all of it.
    await words(page).waitFor({ timeout: 1000 })
    await expect(words(page)).toHaveText(OPENING, { timeout: 1 })
  })
})
