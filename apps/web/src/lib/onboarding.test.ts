import type { Conversation } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { onboardingFor } from "./onboarding"

const conversation = (kind: Conversation["kind"], archived = false) =>
  ({
    id: `${kind}-id`,
    kind,
    title: null,
    archived_at: archived ? "2026-09-27T10:00:00.000Z" : null,
    created_at: "2026-09-27T10:00:00.000Z",
    updated_at: "2026-09-27T10:00:00.000Z",
  }) as Conversation

const NEW = [conversation("assistant"), conversation("onboarding")]

it("a new owner lands in their onboarding conversation", () => {
  expect(onboardingFor(EMPTY_WORKSPACE, NEW)).toBe("onboarding-id")
})

it("an owner with a site, a build, or no onboarding row stays on /app", () => {
  const built = { ...EMPTY_WORKSPACE, builds: [{}] } as unknown as Workspace
  expect(onboardingFor({ ...EMPTY_WORKSPACE, live: 1 }, NEW)).toBeNull()
  expect(onboardingFor(built, NEW)).toBeNull()
  expect(
    onboardingFor(EMPTY_WORKSPACE, [conversation("onboarding", true)])
  ).toBeNull()
  expect(onboardingFor(EMPTY_WORKSPACE, [conversation("assistant")])).toBeNull()
  // A failed read is not a reason to move the owner anywhere.
  expect(onboardingFor(null, NEW)).toBeNull()
  expect(onboardingFor(EMPTY_WORKSPACE, null)).toBeNull()
})
