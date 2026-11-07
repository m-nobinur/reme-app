import { expect, test } from "@playwright/test"
import { axe, open } from "./helpers"

/** Only an owner message sent from WhatsApp carries the caption. */
test("a WhatsApp message is captioned and a web one is not", async ({
  page,
}) => {
  await open(page, "ThreadFromWhatsApp", 390)
  const roots = page.locator('[data-slot="aui_user-message-root"]')
  await expect(roots).toHaveCount(2)
  await expect(roots.nth(0)).toContainText("From WhatsApp")
  await expect(roots.nth(1)).not.toContainText("From WhatsApp")
  await axe(page, "ThreadFromWhatsApp")
})
