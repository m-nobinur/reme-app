/**
 * The cookie that remembers whether the workspace panel is open. A plain
 * module, so the server can read the name without importing the shell and the
 * dialog code under it.
 */
export const PANEL_COOKIE = "reme-panel"

/** The cookie that remembers whether the rail is open, from `md`. */
export const RAIL_COOKIE = "reme-rail"

/**
 * A request to show the panel: a fresh `key` per request, so asking twice
 * opens it twice, and the id of what to move focus to once it is open.
 */
export type PanelPress = { key: string; focus?: string | undefined }

/**
 * The app asking the panel to open or fold by itself: a fresh `key` per
 * request. Unlike a press, it is not remembered as the owner's choice.
 */
export type PanelAuto = { key: string; open: boolean }
