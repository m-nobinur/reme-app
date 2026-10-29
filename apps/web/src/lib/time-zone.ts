import { browserZone } from "@workspace/ui/lib/zone"
import { useEffect } from "react"
import { syncTimeZone } from "./api/server"

/**
 * Once per load, the zone this browser keeps goes to the org, which takes it
 * only while it has none, so check-ins, quiet hours and reminders run on a
 * clock from the first visit. After that the business's zone is set from
 * its service area or by the owner through the assistant, never by a
 * browser. A failure waits for the next load or turn.
 */
export function useSyncTimeZone(hasOrg: boolean) {
  useEffect(() => {
    if (!hasOrg) return
    syncTimeZone({ data: { time_zone: browserZone() } }).catch(() => undefined)
  }, [hasOrg])
}
