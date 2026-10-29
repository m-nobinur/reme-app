import { afterAll, vi } from "vitest"

// Files share a worker's module cache, so one that imported a module earlier
// would hand the next file a copy its `vi.mock` never reached. Node packages
// stay cached, which is where the time went.
vi.resetModules()

// The shared scheduler runs queued React work on setImmediate; let it finish
// while this file's window still exists, not after its teardown (#356).
afterAll(() =>
  typeof window === "undefined"
    ? undefined
    : new Promise<void>((done) => setTimeout(done, 0))
)
