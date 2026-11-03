import { QUOTE_FORM_WORDS } from "@workspace/contracts"
import { expect, test } from "vitest"
import { site } from "../src/site-config"

test("the request form's fixed words are the ones the owner's preview shows", () => {
  for (const [key, words] of Object.entries(QUOTE_FORM_WORDS)) {
    expect(site[key as keyof typeof site], key).toBe(words)
  }
})
