// The image has no @types/node, so astro check cannot see what src/favicon.ts
// and src/icon-files.ts read files, build buffers and hash with. The seed copies this to
// src/node-shims.d.ts; the monorepo's starter has the real types instead.
declare module "node:fs" {
  export function existsSync(path: string): boolean
  export function readFileSync(path: string): Uint8Array
}
declare module "node:crypto" {
  export function createHash(algorithm: string): {
    update: (data: string | Uint8Array) => {
      digest: (encoding: "hex") => string
    }
  }
}
declare module "node:path" {
  export const sep: string
  export function resolve(...paths: string[]): string
}
declare const process: { cwd: () => string }
declare const Buffer: { from: (data: string) => Uint8Array }
