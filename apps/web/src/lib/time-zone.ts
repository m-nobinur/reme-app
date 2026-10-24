import { browserZone } from "@workspace/ui/lib/zone"
import { useEffect } from "react"
import { syncTimeZone } from "./api/server"

/**
 * Once per load, the zone this browser keeps goes to the org, which takes it
 * when it differs. Check-ins, quiet hours and reminders then run on the
 * owner's clock from their first visit, not their first chat turn, and
 * follow them when they move. A failure waits for the next load or turn.
 */
export function useSyncTimeZone(hasOrg: boolean) {
  useEffect(() => {
    if (!hasOrg) return
    syncTimeZone({ data: { time_zone: browserZone() } }).catch(() => undefined)
  }, [hasOrg])
}
