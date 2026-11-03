import { expect, type Page, test } from "@playwright/test"
import { open } from "./helpers"

/**
 * The build question card: each question asks with its own inputs, a wrong
 * answer is refused in place, and after an answer's tick the stack moves to
 * the next question on its own, then folds away once all are in.
 */

const tray = (page: Page) =>
  page.locator('[data-slot="build-questions"] [data-slot="question-tray"]')

const pills = (page: Page) => page.locator('[data-slot="build-questions"]')

test("each question asks with its own inputs, a short choice as quick replies", async ({
  page,
}) => {
  await open(page, "BuildQuestionsUI")
  const card = tray(page)
  await expect(card.getByText("1 of 3", { exact: true })).toBeVisible()
  await expect(card.locator('input[type="time"]:visible')).toHaveCount(2)
  await expect(card.getByRole("button", { name: "Next question" })).toHaveCount(
    0
  )
  await card.getByLabel("Opening time").fill("08:00")
  await card.getByLabel("Closing time").fill("17:00")
  await card.getByRole("button", { name: "Next", exact: true }).click()
  const often = pills(page).getByRole("group", {
    name: "How often do most customers book you?",
  })
  await expect(often.getByRole("button")).toHaveText([
    "Weekly",
    "Fortnightly",
    "Monthly",
    "Skip this one",
  ])
  await often.getByRole("button", { name: "Weekly" }).click()
  await expect(card.getByText("3 of 3", { exact: true })).toBeVisible()
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
  await card.getByRole("button", { name: "Next", exact: true }).click()
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
  await card.getByRole("button", { name: "Next", exact: true }).click()
  await pills(page).getByRole("button", { name: "Skip this one" }).click()
  await expect(card.getByText("3 of 3", { exact: true })).toBeVisible()
  await card.getByLabel("Your answer").fill("On the drive")
  await card.getByRole("button", { name: "Done" }).click()
  await expect(
    page.getByText("Thanks, that's everything I needed.")
  ).toBeVisible()
  await expect(page.locator('[data-slot="build-questions"]')).toHaveCount(0)
})

test("the web address question is quick replies, and Yes asks for the name", async ({
  page,
}) => {
  await open(page, "BuildQuestionsAddress")
  const have = pills(page).getByRole("group", {
    name: "Do you already have a web address?",
  })
  await expect(have.getByRole("button")).toHaveText([
    "Yes, I have one",
    "No, help me get one",
    "Skip for now",
  ])
  await have.getByRole("button", { name: "Yes, I have one" }).click()
  const card = tray(page)
  await expect(card.getByRole("heading", { name: "What is it?" })).toBeVisible()
  await card.getByLabel("Your answer").fill("sparkle.co.uk")
  await card.getByRole("button", { name: "Done" }).click()
  await expect(
    page.getByText("Thanks, that's everything I needed.")
  ).toBeVisible()
})
