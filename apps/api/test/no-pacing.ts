import { clock } from "../src/pacing.ts"

// Pacing waits are for the owner's eyes; no test waits on them.
clock.sleep = () => Promise.resolve()
