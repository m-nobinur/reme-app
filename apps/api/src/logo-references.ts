import type { LogoStyle, LogoType } from "@workspace/contracts"
import abstractGeometric from "@workspace/ui/assets/logo-examples/abstract-geometric.webp"
import abstractGradient from "@workspace/ui/assets/logo-examples/abstract-gradient.webp"
import abstractHandDrawn from "@workspace/ui/assets/logo-examples/abstract-hand_drawn.webp"
import abstractLuxury from "@workspace/ui/assets/logo-examples/abstract-luxury.webp"
import abstractMascot from "@workspace/ui/assets/logo-examples/abstract-mascot.webp"
import abstractMinimal from "@workspace/ui/assets/logo-examples/abstract-minimal.webp"
import abstractRetro from "@workspace/ui/assets/logo-examples/abstract-retro.webp"
import abstractThreeD from "@workspace/ui/assets/logo-examples/abstract-three_d.webp"
import emblemGeometric from "@workspace/ui/assets/logo-examples/emblem-geometric.webp"
import emblemGradient from "@workspace/ui/assets/logo-examples/emblem-gradient.webp"
import emblemHandDrawn from "@workspace/ui/assets/logo-examples/emblem-hand_drawn.webp"
import emblemLuxury from "@workspace/ui/assets/logo-examples/emblem-luxury.webp"
import emblemMascot from "@workspace/ui/assets/logo-examples/emblem-mascot.webp"
import emblemMinimal from "@workspace/ui/assets/logo-examples/emblem-minimal.webp"
import emblemRetro from "@workspace/ui/assets/logo-examples/emblem-retro.webp"
import emblemThreeD from "@workspace/ui/assets/logo-examples/emblem-three_d.webp"
import iconGeometric from "@workspace/ui/assets/logo-examples/icon-geometric.webp"
import iconGradient from "@workspace/ui/assets/logo-examples/icon-gradient.webp"
import iconHandDrawn from "@workspace/ui/assets/logo-examples/icon-hand_drawn.webp"
import iconLuxury from "@workspace/ui/assets/logo-examples/icon-luxury.webp"
import iconMascot from "@workspace/ui/assets/logo-examples/icon-mascot.webp"
import iconMinimal from "@workspace/ui/assets/logo-examples/icon-minimal.webp"
import iconRetro from "@workspace/ui/assets/logo-examples/icon-retro.webp"
import iconThreeD from "@workspace/ui/assets/logo-examples/icon-three_d.webp"
import lockupGeometric from "@workspace/ui/assets/logo-examples/lockup-geometric.webp"
import lockupGradient from "@workspace/ui/assets/logo-examples/lockup-gradient.webp"
import lockupHandDrawn from "@workspace/ui/assets/logo-examples/lockup-hand_drawn.webp"
import lockupLuxury from "@workspace/ui/assets/logo-examples/lockup-luxury.webp"
import lockupMascot from "@workspace/ui/assets/logo-examples/lockup-mascot.webp"
import lockupMinimal from "@workspace/ui/assets/logo-examples/lockup-minimal.webp"
import lockupRetro from "@workspace/ui/assets/logo-examples/lockup-retro.webp"
import lockupThreeD from "@workspace/ui/assets/logo-examples/lockup-three_d.webp"
import monogramGeometric from "@workspace/ui/assets/logo-examples/monogram-geometric.webp"
import monogramGradient from "@workspace/ui/assets/logo-examples/monogram-gradient.webp"
import monogramHandDrawn from "@workspace/ui/assets/logo-examples/monogram-hand_drawn.webp"
import monogramLuxury from "@workspace/ui/assets/logo-examples/monogram-luxury.webp"
import monogramMascot from "@workspace/ui/assets/logo-examples/monogram-mascot.webp"
import monogramMinimal from "@workspace/ui/assets/logo-examples/monogram-minimal.webp"
import monogramRetro from "@workspace/ui/assets/logo-examples/monogram-retro.webp"
import monogramThreeD from "@workspace/ui/assets/logo-examples/monogram-three_d.webp"
import wordmarkGeometric from "@workspace/ui/assets/logo-examples/wordmark-geometric.webp"
import wordmarkGradient from "@workspace/ui/assets/logo-examples/wordmark-gradient.webp"
import wordmarkHandDrawn from "@workspace/ui/assets/logo-examples/wordmark-hand_drawn.webp"
import wordmarkLuxury from "@workspace/ui/assets/logo-examples/wordmark-luxury.webp"
import wordmarkMascot from "@workspace/ui/assets/logo-examples/wordmark-mascot.webp"
import wordmarkMinimal from "@workspace/ui/assets/logo-examples/wordmark-minimal.webp"
import wordmarkRetro from "@workspace/ui/assets/logo-examples/wordmark-retro.webp"
import wordmarkThreeD from "@workspace/ui/assets/logo-examples/wordmark-three_d.webp"

/**
 * The example picture for a logo type in a style: the layout and look the
 * image model is told to take. Bundled with the worker (wrangler's `Data`
 * rule for `.webp`), so a draw makes no fetch to the web app. Each import is
 * named because the bundler does not follow a computed path to a Data module.
 */
const EXAMPLES: Record<`${LogoType}_${LogoStyle}`, ArrayBuffer> = {
  lockup_minimal: lockupMinimal,
  lockup_geometric: lockupGeometric,
  lockup_gradient: lockupGradient,
  lockup_mascot: lockupMascot,
  lockup_hand_drawn: lockupHandDrawn,
  lockup_luxury: lockupLuxury,
  lockup_retro: lockupRetro,
  lockup_three_d: lockupThreeD,
  icon_minimal: iconMinimal,
  icon_geometric: iconGeometric,
  icon_gradient: iconGradient,
  icon_mascot: iconMascot,
  icon_hand_drawn: iconHandDrawn,
  icon_luxury: iconLuxury,
  icon_retro: iconRetro,
  icon_three_d: iconThreeD,
  wordmark_minimal: wordmarkMinimal,
  wordmark_geometric: wordmarkGeometric,
  wordmark_gradient: wordmarkGradient,
  wordmark_mascot: wordmarkMascot,
  wordmark_hand_drawn: wordmarkHandDrawn,
  wordmark_luxury: wordmarkLuxury,
  wordmark_retro: wordmarkRetro,
  wordmark_three_d: wordmarkThreeD,
  monogram_minimal: monogramMinimal,
  monogram_geometric: monogramGeometric,
  monogram_gradient: monogramGradient,
  monogram_mascot: monogramMascot,
  monogram_hand_drawn: monogramHandDrawn,
  monogram_luxury: monogramLuxury,
  monogram_retro: monogramRetro,
  monogram_three_d: monogramThreeD,
  emblem_minimal: emblemMinimal,
  emblem_geometric: emblemGeometric,
  emblem_gradient: emblemGradient,
  emblem_mascot: emblemMascot,
  emblem_hand_drawn: emblemHandDrawn,
  emblem_luxury: emblemLuxury,
  emblem_retro: emblemRetro,
  emblem_three_d: emblemThreeD,
  abstract_minimal: abstractMinimal,
  abstract_geometric: abstractGeometric,
  abstract_gradient: abstractGradient,
  abstract_mascot: abstractMascot,
  abstract_hand_drawn: abstractHandDrawn,
  abstract_luxury: abstractLuxury,
  abstract_retro: abstractRetro,
  abstract_three_d: abstractThreeD,
}

export const logoReference = (type: LogoType, style: LogoStyle) =>
  new Uint8Array(EXAMPLES[`${type}_${style}`])
