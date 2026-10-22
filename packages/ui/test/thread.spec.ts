import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The conversation surface: the empty state the owner opens on, the composer
 * row, and a conversation across two days. Each entry loads alone, so the
 * phone and desktop runs see the layout the owner would.
 */

const WIDTHS = { phone: 390, desktop: 1440 } as const

const input = (page: Page) => page.getByLabel("Message input")
const menu = (page: Page) => page.locator('[data-slot="dropdown-menu-content"]')

/** Opens a menu and waits for its entry transition, so a scan sees it settled. */
async function openMenu(page: Page, name: RegExp | string) {
  await page.getByRole("button", { name }).click()
  await expect(menu(page)).toBeVisible()
  // A transition cut short rejects `finished`; that is settled too. Reme's
  // float and blink never end, so they are not waited on.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getTiming().iterations !==
            Number.POSITIVE_INFINITY
        )
        .map((animation) => animation.finished.catch(() => undefined))
    )
  )
}

async function closeMenu(page: Page) {
  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
}

test("the empty state loads without entrance motion", async ({ page }) => {
  await open(page, "ThreadEmpty")
  // Page-load choreography is banned: nothing on the welcome animates in.
  const moving = await page
    .locator('[data-entry="ThreadEmpty"]')
    .evaluate((root) =>
      [root, ...root.querySelectorAll("*")]
        .filter((node) => {
          const style = getComputedStyle(node)
          // Reme's float and blink loop for as long as the page is open.
          return (
            style.animationName !== "none" &&
            style.animationIterationCount !== "infinite"
          )
        })
        .map((node) => node.className)
    )
  expect(moving).toEqual([])
})

/** The animations running on anything inside one catalog entry. */
const animationsIn = (page: Page, entry: string) =>
  page.locator(`[data-entry="${entry}"]`).evaluate((root) =>
    document
      .getAnimations()
      .filter(
        (animation) =>
          animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY
      )
      .map((animation) => (animation.effect as KeyframeEffect | null)?.target)
      .filter((target) => target instanceof Element && root.contains(target))
      .map(
        (target) =>
          (target as Element).getAttribute("data-slot") ??
          (target as Element).className
      )
  )

test("stored messages arrive still, not animated in", async ({ page }) => {
  // Once history loads, every old message would otherwise play an entrance:
  // page-load choreography by another route.
  await open(page, "Thread")
  expect(await animationsIn(page, "Thread")).toEqual([])
})

test.describe("with reduced motion", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } })

  for (const entry of [
    "Thread",
    "ThreadEmpty",
    "ThreadRunning",
    "ThreadLoading",
    "ThreadError",
  ]) {
    test(`${entry} runs no animation`, async ({ page }) => {
      await open(page, entry)
      expect(await animationsIn(page, entry)).toEqual([])
    })
  }
})

test("the empty state opens on the briefing and what to ask", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  await expect(
    page.getByRole("heading", { name: "What should we do today?" })
  ).toBeVisible()
  await expect(page.locator('[data-slot="aui_thread-briefing"]')).toHaveText(
    "Your website is live. A new version is ready for you to approve."
  )
  await expect(input(page)).toHaveAttribute(
    "placeholder",
    "Ask Ellie anything…"
  )
  await expect(page.locator(".aui-thread-welcome-suggestion")).toHaveText([
    "What changed in the new version?",
    "What do you need from me?",
    "What is on my website now?",
  ])
  // One row each, under the composer, in a single column.
  const composer = await page
    .locator('[data-slot="aui_composer-shell"]')
    .boundingBox()
  const rows = await page
    .locator(".aui-thread-welcome-suggestion")
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const box = node.getBoundingClientRect()
        return { x: box.x, y: box.y }
      })
    )
  expect(rows[0]?.y).toBeGreaterThan(composer?.y ?? 0)
  for (const [index, row] of rows.entries()) {
    expect(row.x).toBe(rows[0]?.x)
    if (index > 0) expect(row.y).toBeGreaterThan(rows[index - 1]?.y ?? 0)
  }
})

test("with nothing read, the empty state has no line", async ({ page }) => {
  await open(page, "ThreadEmptyUnread")
  await expect(page.locator('[data-slot="aui_thread-briefing"]')).toHaveCount(0)
  await expect(page.locator(".aui-thread-welcome-suggestion")).toHaveCount(0)
})

test("a quick action puts its sentence in the composer, focused", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  await openMenu(page, "Quick actions")
  await menu(page).getByRole("menuitem", { name: "Change my website" }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(input(page)).toHaveValue("On my website, please change ")
  await expect(input(page)).toBeFocused()
})

test("a quick action keeps the owner's draft and adds to it", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  await input(page).fill("The Saturday hours are wrong.")
  await openMenu(page, "Quick actions")
  await menu(page).getByRole("menuitem", { name: "Change my website" }).click()
  await expect(input(page)).toHaveValue(
    "The Saturday hours are wrong.\nOn my website, please change "
  )
  await expect(input(page)).toBeFocused()
})

test("website change mode shows a chip beside +, and its × leaves the mode", async ({
  page,
}) => {
  await open(page, "ThreadSiteChange")
  const chip = page.locator('[data-slot="aui_composer-mode"]')
  await expect(chip).toHaveText("Website change")
  await expect(input(page)).toHaveAttribute(
    "placeholder",
    "Describe what to change on your website…"
  )
  // Beside "+", on its right.
  const plus = await page
    .getByRole("button", { name: "Quick actions" })
    .boundingBox()
  const box = await chip.boundingBox()
  expect(box?.x).toBeGreaterThanOrEqual((plus?.x ?? 0) + (plus?.width ?? 0))
  await axe(page, "ThreadSiteChange")

  await page.getByRole("button", { name: "Leave website change mode" }).click()
  await expect(chip).toHaveCount(0)
  await expect(input(page)).toHaveAttribute(
    "placeholder",
    "Ask Ellie anything…"
  )
  await expect(input(page)).toBeFocused()
})

test("Escape from quick actions hands focus back to the button", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  await openMenu(page, "Quick actions")
  await page.keyboard.press("Escape")
  await expect(menu(page)).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Quick actions" })
  ).toBeFocused()
  await expect(input(page)).toHaveValue("")
})

test("the composer's focus is a lighter edge, with no ring", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  const shell = page.locator('[data-slot="aui_composer-shell"]')
  const style = () =>
    shell.evaluate((each) => {
      const { boxShadow, borderTopColor } = getComputedStyle(each)
      return { boxShadow, borderTopColor }
    })
  await input(page).blur()
  const before = await style()
  await input(page).focus()
  await expect
    .poll(async () => (await style()).borderTopColor)
    .not.toBe(before.borderTopColor)
  expect((await style()).boxShadow).toBe("none")
})

test.describe("in London in summer time", () => {
  test.use({ timezoneId: "Europe/London" })

  test("each day of the conversation opens with its local date", async ({
    page,
  }) => {
    // The fixture's second question is at 23:30Z on the 25th, which is 00:30
    // on the 26th here: one rule for the 26th, not one for the 25th as well.
    await open(page, "Thread")
    await expect(
      page.locator('[data-slot="aui_date-divider"] time')
    ).toHaveText([/^24 Sept? 2026$/, /^26 Sept? 2026$/])
  })

  test("each message shows its local time, and the owner's a tick", async ({
    page,
  }) => {
    await open(page, "Thread")
    const meta = page.locator('[data-slot="aui_user-message-meta"]').first()
    await expect(meta.locator("time")).toHaveText("10:30 am")
    // Answered, so seen.
    await expect(meta).toContainText("Seen")
    // Under the bubble, not inside it, and flush with its right edge.
    const bubble = await page
      .locator(".aui-user-message-content")
      .first()
      .boundingBox()
    const metaBox = await meta.boundingBox()
    expect(bubble && metaBox).toBeTruthy()
    if (bubble && metaBox) {
      expect(metaBox.y).toBeGreaterThanOrEqual(bubble.y + bubble.height)
      expect(
        Math.abs(bubble.x + bubble.width - (metaBox.x + metaBox.width))
      ).toBeLessThanOrEqual(12)
    }
    await expect(
      page.locator('[data-slot="aui_assistant-message-footer"] time').first()
    ).toHaveText("10:31 am")
  })
})

test("a message whose reply failed keeps one tick", async ({ page }) => {
  // A failed turn never reached Reme, so it is sent, not delivered.
  await open(page, "ThreadError")
  await expect(
    page.locator('[data-slot="aui_user-message-delivery"]').last()
  ).toHaveAttribute("data-state", "sent")
})

test("the owner's messages sit right and the replies left", async ({
  page,
}) => {
  await open(page, "Thread")
  const user = page.locator(".aui-user-message-content").first()
  const reply = page
    .locator('[data-slot="aui_assistant-message-content"]')
    .first()
  const userBox = await user.boundingBox()
  const replyBox = await reply.boundingBox()
  expect(userBox && replyBox).toBeTruthy()
  if (userBox && replyBox) {
    expect(userBox.x).toBeGreaterThan(replyBox.x + 100)
  }
})

test("a running reply offers Stop, and a failed one says why", async ({
  page,
}) => {
  await open(page, "ThreadRunning")
  await expect(
    page.getByRole("button", { name: "Stop generating" })
  ).toBeVisible()

  await open(page, "ThreadError")
  await expect(
    page.getByText("The workspace did not answer. Try again in a moment.")
  ).toBeVisible()
})

test("a new chat's composer is the tall one, with its buttons under the field", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  const field = await input(page).boundingBox()
  const plus = await page
    .getByRole("button", { name: "Quick actions" })
    .boundingBox()
  if (!field || !plus) throw new Error("not laid out")
  expect(plus.y).toBeGreaterThanOrEqual(field.y + field.height)
})

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries(WIDTHS)) {
    test(`the conversation has no accessibility violations on a ${name} in ${theme}`, async ({
      page,
    }) => {
      await open(page, "Conversation", width, theme)
      await axe(page, `${name} ${theme}`)

      await openMenu(page, "Quick actions")
      await axe(page, `${name} ${theme} quick actions`)
      await closeMenu(page)
    })
  }
}

for (const theme of ["light", "dark"] as const) {
  for (const [name, width] of Object.entries({
    phone: 390,
    tablet: 768,
    desktop: 1440,
  })) {
    test(`a reply's markdown image never loads, and an outside link names its host, on a ${name} in ${theme}`, async ({
      page,
    }) => {
      const fetched: string[] = []
      page.on("request", (request) => {
        if (request.url().startsWith("https://example.net/")) {
          fetched.push(request.url())
        }
      })
      await open(page, "MarkdownText", width, theme)
      const reply = page.locator('[data-entry="MarkdownText"] .aui-md')
      await expect(reply).toContainText("Photos of the shop front")
      await expect(reply.locator("img")).toHaveCount(0)
      const outside = reply.getByRole("link", {
        name: "the site (example.net) (opens in a new tab)",
      })
      await expect(outside).toHaveAttribute("target", "_blank")
      await expect(outside).toHaveAttribute("rel", "noopener noreferrer")
      // The host is the app's, set apart from the text the model wrote.
      await expect(outside.locator(".aui-md-a-host bdi[dir='ltr']")).toHaveText(
        "example.net"
      )
      // An in-page link stays in the tab.
      const inPage = reply.getByRole("link", { name: "revision", exact: true })
      await expect(inPage).not.toHaveAttribute("target", /./)
      await axe(page, `MarkdownText ${theme} ${name}`)
      expect(fetched).toEqual([])
    })
  }
}
