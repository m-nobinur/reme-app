import type { Page } from "@playwright/test"

/**
 * `page.goto` plus the wait every interaction on a server-rendered page needs.
 *
 * Playwright waits for an element to be visible, enabled and stable before it
 * clicks. None of that says React has attached a handler to it, and these pages
 * arrive as HTML first. For a few hundred milliseconds the sign-in form is a
 * real form with real inputs and no JavaScript behind it. A click in that window
 * submits it natively. It is `<form method="post">` with no `action`, so it
 * posts the page back to itself with no fields, the entered credentials are
 * discarded, and the app either sits on the same page or reports that it could
 * not reach the sign-in service.
 *
 * Measured on staging rather than guessed at. Without this wait, 5 of 30
 * sign-in attempts failed that way, and the failing attempt made no request to a server
 * function at all and created no WorkOS session. With it, 25 of 25 passed. A
 * retry would have hidden the same thing at a quarter of the cost, which is
 * why there is none. The suite runs with `retries: 0`.
 *
 * The condition is React's own. A DOM node carries a `__reactFiber$…` key once
 * React has hydrated it, in development and in production builds alike, and
 * that is exactly the moment the handler exists. Framework-internal, and no
 * public API says the same thing; `load`, `domcontentloaded` and `networkidle`
 * all say nothing about hydration.
 *
 * A person can hit this window too. It is rarer for them than for a machine
 * that clicks the instant the button appears, but it is the same defect, and it
 * belongs to the sign-in form rather than to this suite.
 */
export async function visit(
  page: Page,
  path: string,
  /** The element about to be used, when it is not enough that the page shell is live. */
  selector = "main"
): Promise<void> {
  await page.goto(path)
  await hydrated(page, selector)
}

export async function hydrated(page: Page, selector: string): Promise<void> {
  await page.waitForFunction(
    (target) => {
      const node = document.querySelector(target)
      return (
        !!node &&
        Object.keys(node).some((key) => key.startsWith("__reactFiber$"))
      )
    },
    selector,
    { timeout: 20_000 }
  )
}
