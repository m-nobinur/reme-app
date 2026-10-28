import { vi } from "vitest"

// Files share a worker's module cache, so one that imported a module earlier
// would hand the next file a copy its `vi.mock` never reached. Node packages
// stay cached, which is where the time went.
vi.resetModules()
