import type {
  AskDesignInput,
  AskDesignOutput,
  DrawLogosRequest,
  KeptLogo,
  LogoPalettes,
  LogoRound,
  LogoRounds,
  PaletteFromImage,
  ReviewedPhotos,
  UploadedAssets,
} from "@workspace/contracts"
import { createContext, useContext } from "react"

/**
 * What the design tray's logo, photos and palette pages call on the app.
 * The web gives them through `TrayServicesProvider`; the catalog gives
 * fakes. Each throws an `Error` whose message is a sentence for the owner.
 */
export type TrayServices = {
  /** `POST /assets`: stores the files and answers what was stored. */
  upload: (files: File[]) => Promise<UploadedAssets>
  /** `POST /assets/review`: reads the stored photos against the photo needs. */
  reviewPhotos: (assetIds: string[]) => Promise<ReviewedPhotos>
  /** `POST /palettes/from-image`: the palette in a picture, which is not stored. */
  paletteFromImage: (file: File) => Promise<PaletteFromImage>
  /** `POST /palettes/from-logo`: the kept logo read into palettes, held per logo. */
  logoPalettes: (assetId: string) => Promise<LogoPalettes>
  /**
   * `POST /logos`: starts a round of logos and answers it as it starts. A
   * round asked for before its wait is over throws with `retryAfter`, the
   * seconds left.
   */
  drawLogos: (request: DrawLogosRequest) => Promise<LogoRound>
  /** `GET /logos`: every round drawn for one tray's logo question. */
  logoRounds: (toolCallId: string) => Promise<LogoRounds>
  /** `POST /logos/{id}/keep`: a variant or an uploaded file, kept as the logo. */
  keepLogo: (id: string) => Promise<KeptLogo>
  /** Where an `<img>` loads a stored or generated image of the org. */
  imageUrl: (id: string) => string
}

const ServicesContext = createContext<TrayServices | null>(null)

/** Gives the tray's pages the app's services. */
export const TrayServicesProvider = ServicesContext.Provider

/** The app's services, or null where none were given: a page then says it cannot upload here. */
export const useTrayServices = () => useContext(ServicesContext)

type Question = AskDesignInput["questions"][number]
type Answer = AskDesignOutput["answers"][string]

/**
 * A tray page that is more than a list of options: the logo and the photos.
 * The page holds its own working state and sets the question's answer once
 * it is settled (`onAnswer(undefined)` clears it), which enables Next.
 */
export type TrayPageProps<A extends Answer> = {
  question: Question
  /** The tray's own call, which names its logo rounds. */
  toolCallId: string
  answer: A | undefined
  onAnswer: (answer: A | undefined) => void
  /** Sets the answer and goes on, as Next would: for a choice that is itself the way past. */
  onNext?: (answer: A) => void
  /** The site's four colours as picked so far: paper, tint, primary, ink. */
  stops: readonly [string, string, string, string]
  businessName: string
}
