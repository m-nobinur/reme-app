import type { Conversation } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { Workspace } from "./api/types"
import { EMPTY_WORKSPACE } from "./attention"
import { onboardingFor, settingUp } from "./onboarding"

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

it("is setting up while the onboarding segment is open, and not once it is done", () => {
  const at = (state: string) =>
    ({
      ...EMPTY_WORKSPACE,
      activity: { journey: [{ kind: "onboarding", state }], now: [] },
    }) as unknown as Workspace
  expect(settingUp(at("now"))).toBe(true)
  expect(settingUp(at("waiting"))).toBe(true)
  // A skipped website ends setup with nothing built.
  expect(settingUp(at("done"))).toBe(false)
  expect(settingUp(EMPTY_WORKSPACE)).toBe(false)
  expect(settingUp(null)).toBe(false)
})
