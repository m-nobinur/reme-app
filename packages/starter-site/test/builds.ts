import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    builds: string
  }
}

/** Where `build` keeps a run's builds, so files asking for the same one share it. */
export default function setup(project: TestProject) {
  const dir = mkdtempSync(join(tmpdir(), "reme-starter-"))
  project.provide("builds", dir)
  return () => rmSync(dir, { recursive: true, force: true })
}
