import type { Asset } from "@workspace/contracts"
import type { TrayPageProps } from "@workspace/ui/components/assistant/tray-services"

/** The logo question's answer: the logo kept. */
export type LogoAnswer = { logo: Asset }

/** The logo question's page in the design tray. */
function TrayLogo(_: TrayPageProps<LogoAnswer>) {
  return null
}

export { TrayLogo }
