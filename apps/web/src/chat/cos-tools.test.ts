import { expect, it } from "vitest"
import type { AttentionItem } from "@/lib/api/types"
import { cosTools, questionTitles } from "./cos-tools"

const item = (kind: string, id: string, title: string) =>
  ({ kind, id, title }) as AttentionItem

it("keeps one key while a poll changes nothing the cards show", () => {
  const first = questionTitles([
    item("question", "q1", "Your phone number"),
    item("alert", "a1", "Build stopped"),
  ])
  const later = questionTitles([
    item("report", "r1", "Draft ready"),
    item("question", "q1", "Your phone number"),
  ])
  expect(later).toBe(first)
  expect(questionTitles([item("question", "q1", "Your email")])).not.toBe(first)
})

it("names an open question, and none that is not open", () => {
  const { question } = cosTools(
    questionTitles([item("question", "q1", "Your phone number")])
  )
  expect(question("q1")).toBe("Your phone number")
  expect(question("q2")).toBeNull()
  expect(cosTools(questionTitles()).question("q1")).toBeNull()
})
