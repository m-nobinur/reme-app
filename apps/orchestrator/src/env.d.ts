/** Secrets from `.dev.vars` locally and Worker secrets deployed (R9). */
interface Env {
  ORCHESTRATOR_TOKEN: string
}

/** Vite's `?raw` import, for the console page. */
declare module "*.html?raw" {
  const html: string
  export default html
}
