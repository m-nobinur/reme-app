import assert from "node:assert/strict"
import { test } from "node:test"
import { SHAPES } from "./redact.mjs"

const email = SHAPES.find(([kind]) => kind === "email")[1]
const caught = (text) => (text.match(email) ?? []).length > 0

test("an email on an RFC 2606 reserved domain is allowed", () => {
  for (const address of [
    "hello@example.com",
    "hello@example.net.",
    "Mail hello@example.org, thanks",
    "hello@mail.example.net",
  ])
    assert.equal(caught(address), false, address)
})

test("an email on any other domain is still refused", () => {
  for (const address of [
    "hello@gmail.com",
    "hello@example.co.uk",
    "hello@example.net.evil.com",
    "hello@notexample.net",
    "hello@example-net.com",
    "hello@remeai.co.uk",
  ])
    assert.equal(caught(address), true, address)
})
