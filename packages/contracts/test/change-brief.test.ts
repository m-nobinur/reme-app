import { describe, expect, it } from "vitest"
import { CosChangeRequest, ReadSiteOutput } from "../src/cos.ts"
import {
  ChangeBrief,
  EDIT_KIND,
  EditType,
  OwnerChangeRequest,
  PagePath,
} from "../src/owner.ts"
import { BlockChange, ChangeChecked } from "../src/report.ts"
import { DeploymentManifest } from "../src/site.ts"

const brief = {
  edit_type: "add_section",
  targets: [{ page: "about", section: "story" }],
  content: "We started in 2019 with one van.",
  placement: "after section intro on about",
  acceptance: [
    "The About page has a section headed Our story",
    "It says: We started in 2019 with one van.",
  ],
}

describe("change brief", () => {
  it("rides request_change, with the owner's words only on the API's side", () => {
    expect(
      OwnerChangeRequest.safeParse({
        text: "Add our story to About",
        brief: { ...brief, owner_words: "add our story to the about page" },
      }).success
    ).toBe(true)
    expect(
      CosChangeRequest.safeParse({ text: "Add our story to About", brief })
        .success
    ).toBe(true)
    expect(
      CosChangeRequest.safeParse({
        text: "Add our story to About",
        brief: { ...brief, owner_words: "x" },
      }).success
    ).toBe(false)
  })

  it("needs two or three acceptance checks", () => {
    expect(
      ChangeBrief.safeParse({ ...brief, acceptance: ["one"] }).success
    ).toBe(false)
    expect(
      ChangeBrief.safeParse({ ...brief, acceptance: ["a", "b", "c", "d"] })
        .success
    ).toBe(false)
  })

  it("gives every edit type a lane", () => {
    expect(Object.keys(EDIT_KIND).sort()).toEqual([...EditType.options].sort())
    expect(EDIT_KIND.move).toBe("copy")
    expect(EDIT_KIND.add_page).toBe("creative")
  })

  it("names pages the way the document files do", () => {
    for (const ok of ["about", "service-area", "services/deep-clean"])
      expect(PagePath.safeParse(ok).success).toBe(true)
    for (const bad of ["service_area", "../about", "about.json", "a/b/c"])
      expect(PagePath.safeParse(bad).success).toBe(false)
  })
})

describe("change records", () => {
  it("keep a block's text before and after", () => {
    expect(
      BlockChange.safeParse({
        page: "about",
        section: "story",
        block: "story-text",
        change: "added",
        before: "",
        after: "We started in 2019.",
      }).success
    ).toBe(true)
    expect(
      ChangeChecked.safeParse({
        report_id: crypto.randomUUID(),
        round: 3,
        checks: [{ check: "a", passed: true, why: "b" }],
      }).success
    ).toBe(false)
  })

  it("lets a manifest redirect a removed page", () => {
    const manifest = {
      revision_id: crypto.randomUUID(),
      site_id: crypto.randomUUID(),
      org_id: crypto.randomUUID(),
      routes: [],
      headers: {},
      files: {},
      built_at: new Date().toISOString(),
    }
    expect(DeploymentManifest.safeParse(manifest).success).toBe(true)
    expect(
      DeploymentManifest.safeParse({
        ...manifest,
        redirects: { "/services/oven/": "/services/" },
      }).success
    ).toBe(true)
    expect(
      DeploymentManifest.safeParse({
        ...manifest,
        redirects: { "/services/oven/": "https://evil.example/" },
      }).success
    ).toBe(false)
  })

  it("outlines a site by its ids", () => {
    expect(
      ReadSiteOutput.safeParse({
        outcome: "found",
        about: "draft",
        notes: ["Bullets, not paragraphs"],
        pages: [
          {
            page: "home",
            title: null,
            sections: [
              {
                id: "faq",
                kind: "faq",
                heading: "Questions",
                blocks: [{ id: "faq-list", type: "faq", provenance: "trade" }],
              },
            ],
          },
        ],
      }).success
    ).toBe(true)
  })
})
