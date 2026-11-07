import { expect, type Page, test } from "@playwright/test"
import { axe, open } from "./helpers"

/**
 * The conversation surface: the empty state the owner opens on, the composer
 * row, and a conversation across two days. Each entry loads alone, so the
 * phone and desktop runs see the layout the owner would.
 */

const WIDTHS = { phone: 390, desktop: 1440 } as const

const input = (page: Page) => page.getByLabel("Message input")
/** What the catalog's dictation hears. */
const HEARD = "Please book a clean for Friday morning"
const menu = (page: Page) => page.locator('[data-slot="dropdown-menu-content"]')

/** Opens a menu and waits for its entry transition, so a scan sees it settled. */
async function openMenu(page: Page, name: RegExp | string) {
  await page.getByRole("button", { name }).click()
  await expect(menu(page)).toBeVisible()
  // A transition cut short rejects `finished`; that is settled too. Reme's
  // float and blink never end, nor does the panel's scroll-driven fade, so
  // they are not waited on.
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.timeline instanceof DocumentTimeline &&
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

test("the empty state opens on the briefing, with no chips above the composer", async ({
  page,
}) => {
  await open(page, "ThreadEmpty")
  await expect(
    page.getByRole("heading", { name: "What should we do today?" })
  ).toBeVisible()
  await expect(page.locator('[data-slot="aui_thread-briefing"]')).toHaveText(
    "Your website is live. Your latest changes are ready to publish."
  )
  await expect(input(page)).toHaveAttribute("placeholder", "Ask Reme anything…")
  await expect(page.locator('[data-slot="chip-row"]')).toHaveCount(0)
})

test("on a phone a row of chips scrolls sideways and fades at the edge", async ({
  page,
}) => {
  await open(page, "ChipRow", WIDTHS.phone)
  const row = page.locator('[data-slot="chip-row"]')
  await row.evaluate((node) => node.scrollTo({ left: 0 }))
  const last = page.getByRole("button", {
    name: "Summarise this week's enquiries",
  })
  await expect(row).toHaveAttribute("data-fade-end", "true")
  await expect(row).not.toHaveAttribute("data-fade-start")
  expect(
    await row.evaluate((node) => node.scrollWidth > node.clientWidth)
  ).toBe(true)
  // Tab walks the row: the last chip takes the focus and scrolls into view.
  await page
    .getByRole("button", { name: "Draft three onboarding prompts" })
    .focus()
  for (let press = 0; press < 3; press++) await page.keyboard.press("Tab")
  await expect(last).toBeFocused()
  await expect(row).toHaveAttribute("data-fade-start", "true")
  await expect(row).not.toHaveAttribute("data-fade-end")
  const chip = await last.boundingBox()
  const edge = await row.boundingBox()
  expect((chip?.x ?? 0) + (chip?.width ?? 0)).toBeLessThanOrEqual(
    (edge?.x ?? 0) + (edge?.width ?? 0)
  )
})

test("dictating shows the level, × and ✓ in place of the mic and send, the words still settling muted", async ({
  page,
}) => {
  await open(page, "ThreadDictating", WIDTHS.phone)
  await expect(input(page)).toHaveValue(HEARD)
  await expect(page.getByRole("button", { name: "Dictate" })).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Send message" })).toHaveCount(
    0
  )
  // Still being recognised: drawn over the field, muted and italic.
  const phrase = page.locator('[data-slot="aui_dictation-heard"] span')
  await expect(phrase).toHaveText(HEARD)
  await expect(phrase).toHaveCSS("font-style", "italic")
  // Speaking: the dots have risen into bars, and say nothing to a reader.
  const meter = page.locator('[data-slot="aui_dictation-level"]')
  await expect(meter).toHaveAttribute("aria-hidden", "true")
  await expect
    .poll(() =>
      meter
        .locator("span")
        .nth(2)
        .evaluate((bar) => bar.getBoundingClientRect().height)
    )
    .toBeGreaterThan(10)
  const cancel = page.getByRole("button", { name: "Cancel dictation" })
  const done = page.getByRole("button", { name: "Done" })
  for (const button of [cancel, done]) {
    const box = await button.boundingBox()
    expect(box?.width).toBe(36)
    expect(box?.height).toBe(36)
  }
  await done.focus()
  await expect(done).toBeFocused()
  await done.press("Enter")
  await expect(page.getByRole("button", { name: "Dictate" })).toBeVisible()
  // What was heard stays for the owner to edit or send, and nothing sent.
  await expect(input(page)).toHaveValue(HEARD)
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible()
})

test("listening before a word is heard says so in the field, the dots still", async ({
  page,
}) => {
  await open(page, "ThreadListening", WIDTHS.phone)
  await expect(input(page)).toHaveAttribute("placeholder", "Listening…")
  await expect(input(page)).toHaveValue("")
  const bars = page.locator('[data-slot="aui_dictation-level"] span')
  await expect(bars).toHaveCount(5)
  for (const height of await bars.evaluateAll((all) =>
    all.map((bar) => bar.getBoundingClientRect().height)
  ))
    expect(height).toBe(4)
  // Announced once, in the notice line, without a visible second line.
  const notice = page.locator('[data-slot="aui_dictation-notice"]')
  await expect(notice).toHaveText("Listening")
  await expect(notice).toHaveClass(/sr-only/)
  await axe(page, "listening")
})

test("a dictation that could not start says so under the field", async ({
  page,
}) => {
  await open(page, "ThreadDictationNotice", WIDTHS.phone)
  const notice = page.locator('[data-slot="aui_dictation-notice"]')
  await expect(notice).toHaveText(
    "Microphone access is off. Allow it in your browser to dictate."
  )
  await expect(notice).toHaveAttribute("aria-live", "polite")
  await expect(page.getByRole("button", { name: "Dictate" })).toBeEnabled()
  await expect(
    page.getByLabel("Message input").locator("xpath=ancestor::form")
  ).toBeVisible()
})

/** Hold Space in the composer to dictate, with the mic's adapter in the fixture. */
const dictate = (page: Page) =>
  page.getByRole("button", { name: "Dictate", exact: true })
const done = (page: Page) => page.getByRole("button", { name: "Done" })
/** Longer than the hold that starts dictation, with room to spare. */
const PAST_HOLD = 700

test.describe("hold Space to dictate, the microphone allowed", () => {
  test.use({ permissions: ["microphone"] })

  test("holding Space starts dictation and letting go stops it", async ({
    page,
  }) => {
    await open(page, "ThreadEmptyPhone", WIDTHS.phone)
    await input(page).focus()
    await page.keyboard.down("Space")
    await expect(done(page)).toBeVisible()
    await expect(input(page)).toHaveValue(HEARD)
    await page.keyboard.up("Space")
    await expect(dictate(page)).toBeVisible()
    // The held key typed nothing of its own.
    await expect(input(page)).toHaveValue(HEARD)
  })

  test("× drops what this dictation wrote and keeps what was typed before it", async ({
    page,
  }) => {
    await open(page, "ThreadEmptyPhone", WIDTHS.phone)
    await input(page).fill("Hi ")
    await dictate(page).click()
    await expect(input(page)).toHaveValue(`Hi ${HEARD}`)
    await page.getByRole("button", { name: "Cancel dictation" }).click()
    await expect(dictate(page)).toBeVisible()
    await expect(input(page)).toHaveValue("Hi ")
  })

  test("a short press types a space", async ({ page }) => {
    await open(page, "ThreadEmptyPhone", WIDTHS.phone)
    await input(page).focus()
    await page.keyboard.press("Space")
    await expect(input(page)).toHaveValue(" ")
    await page.waitForTimeout(PAST_HOLD)
    await expect(dictate(page)).toBeVisible()
  })

  test("Space held in the middle of a word types as before", async ({
    page,
  }) => {
    await open(page, "ThreadEmptyPhone", WIDTHS.phone)
    await input(page).fill("Hello")
    await page.keyboard.down("Space")
    await page.waitForTimeout(PAST_HOLD)
    await page.keyboard.up("Space")
    await expect(dictate(page)).toBeVisible()
    await expect(input(page)).toHaveValue("Hello ")
  })

  test("Space held while an input method composes is left to it", async ({
    page,
  }) => {
    await open(page, "ThreadEmptyPhone", WIDTHS.phone)
    await input(page).focus()
    await input(page).dispatchEvent("keydown", {
      key: " ",
      code: "Space",
      isComposing: true,
    })
    await page.waitForTimeout(PAST_HOLD)
    await expect(dictate(page)).toBeVisible()
  })

  test("the mic's tooltip names the shortcut", async ({ page }) => {
    await open(page, "ThreadEmptyPhone", WIDTHS.phone)
    await dictate(page).hover()
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveText(
      "Dictate, or hold Space to talk"
    )
  })
})

test("before the microphone is allowed, holding Space only types", async ({
  page,
}) => {
  await open(page, "ThreadEmptyPhone", WIDTHS.phone)
  await input(page).focus()
  await page.keyboard.down("Space")
  await page.waitForTimeout(PAST_HOLD)
  await page.keyboard.up("Space")
  await expect(dictate(page)).toBeVisible()
  await expect(input(page)).toHaveValue(" ")
})

test("with no notice the composer has no gap for one", async ({ page }) => {
  await open(page, "ThreadEmpty")
  await expect(page.locator('[data-slot="aui_dictation-notice"]')).toBeHidden()
})

test("the new chat greets with the assistant's own face, Reme's without a pick", async ({
  page,
}) => {
  const welcome = page.locator(".aui-thread-welcome-root")
  await open(page, "ThreadEmptyAvatar")
  const picked = welcome.locator('[data-slot="assistant-avatar"]')
  await expect(picked).toBeVisible()
  await expect(picked).toHaveAttribute("aria-hidden", "true")
  expect((await picked.boundingBox())?.width).toBe(56)
  await expect(welcome.getByRole("heading")).toHaveText(
    "What should we do today?"
  )
  await open(page, "ThreadEmpty")
  await expect(welcome.locator('[data-slot="assistant-avatar"]')).toHaveCount(0)
  const reme = welcome.locator("span.rounded-full").first()
  await expect(reme).toBeVisible()
  expect((await reme.boundingBox())?.width).toBe(56)
  await expect(welcome.locator("svg")).toHaveCount(0)
})

test("with nothing read, the empty state has no line", async ({ page }) => {
  await open(page, "ThreadEmptyUnread")
  await expect(page.locator('[data-slot="aui_thread-briefing"]')).toHaveCount(0)
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

test("website change mode takes the place of +, and pressing it leaves the mode", async ({
  page,
}) => {
  await open(page, "ThreadSiteChange")
  const mode = page.locator('[data-slot="aui_composer-mode"]')
  await expect(mode).toHaveAccessibleName(
    "Website change mode. Press to leave it"
  )
  await expect(page.getByRole("button", { name: "Quick actions" })).toHaveCount(
    0
  )
  await expect(input(page)).toHaveAttribute(
    "placeholder",
    "Describe what to change on your website…"
  )
  await axe(page, "ThreadSiteChange")

  await mode.click()
  await expect(mode).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Quick actions" })
  ).toBeVisible()
  await expect(input(page)).toHaveAttribute("placeholder", "Ask Reme anything…")
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
    await expect(meta.locator("time")).toHaveText("10:30 AM")
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
    ).toHaveText("10:31 AM")
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
      const reply = page
        .locator('[data-entry="MarkdownText"] .aui-md')
        .filter({ hasText: "Photos of the shop front" })
      await expect(reply).toHaveCount(1)
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
