import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * The build question card: each question asks with its own inputs, a wrong
 * answer is refused in place, and after an answer's tick the stack moves to
 * the next question on its own, then folds away once all are in.
 */

const tray = (page: Page) =>
  page.locator('[data-slot="build-questions"] [data-slot="question-tray"]')

test("each question asks with its own inputs, one page at a time", async ({
  page,
}) => {
  await open(page, "BuildQuestionsUI")
  const card = tray(page)
  await expect(card.getByText("1 of 3", { exact: true })).toBeVisible()
  await expect(card.locator('input[type="time"]:visible')).toHaveCount(2)
  await card.getByRole("button", { name: "Next question" }).click()
  await expect(card.getByRole("radio")).toHaveCount(3)
  await expect(card.getByRole("button", { name: "Skip" })).toBeVisible()
  await card.getByRole("button", { name: "Next question" }).click()
  await expect(card.getByLabel("Your answer")).toHaveAttribute(
    "maxlength",
    "200"
  )
})

test("hours that close before they open are refused in place", async ({
  page,
}) => {
  await open(page, "BuildQuestionsUI")
  const card = tray(page)
  await card.getByLabel("Opening time").fill("17:00")
  await card.getByLabel("Closing time").fill("08:00")
  await card.getByRole("button", { name: "Send" }).click()
  await expect(card.getByRole("alert")).toHaveText(
    "Closing time has to be after opening time."
  )
  await expect(card.getByText("1 of 3", { exact: true })).toBeVisible()
})

test("an answer ticks, moves on by itself, and the stack folds when done", async ({
  page,
}) => {
  await open(page, "BuildQuestionsUI")
  const card = tray(page)
  await card.getByLabel("Opening time").fill("08:00")
  await card.getByLabel("Closing time").fill("17:00")
  await card.getByRole("button", { name: "Send" }).click()
  await expect(card.getByText("2 of 3", { exact: true })).toBeVisible()
  await card.getByRole("button", { name: "Skip" }).click()
  await expect(card.getByText("3 of 3", { exact: true })).toBeVisible()
  await card.getByLabel("Your answer").fill("On the drive")
  await card.getByRole("button", { name: "Send" }).click()
  await expect(
    page.getByText("Thanks, that's everything I needed.")
  ).toBeVisible()
  await expect(page.locator('[data-slot="build-questions"]')).toHaveCount(0)
})
