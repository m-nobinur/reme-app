/**
 * The preview's screenshots, shared by the step that takes them
 * (`takeScreenshots`) and the design critic that reads them.
 */

/** The widths the preview's screenshots are taken at; the router serves them by these names. */
export const VIEWPORTS = [390, 768, 1440] as const

/** The widths the critic is shown: phone and desktop. A picture costs its pixels, and a tablet width added a third of them. */
export const CROP_WIDTHS = [390, 1440] as const

/** The most viewport-height pieces of the home page the critic gets per width (it was 8: 24 pictures, about 28k tokens a look). */
export const CROPS_MAX = 5

/** The capture script, written to /tmp in the sandbox and run there. */
export const SHOTS_SCRIPT = Object.values(
  import.meta.glob("../sandbox/shots.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>
)[0] as string

/** Where a piece lives in the site bucket: outside `screenshots/`, so the router never serves it. */
export const cropKey = (
  orgId: string,
  revisionId: string,
  width: number,
  part: number
) => `sites/${orgId}/${revisionId}/critic/home-${width}-${part}.jpg`
