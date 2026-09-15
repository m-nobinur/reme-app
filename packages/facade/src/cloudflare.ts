/**
 * The Cloudflare-target half of the flue surface (`@workspace/facade/cloudflare`):
 * the sandbox adapter and the Durable Object extension points. Separate from
 * the index because it pulls in `cloudflare:workers`, which only resolves
 * inside a Worker build.
 */
export {
  type CloudflareSandboxStub,
  cloudflareSandbox,
  extend,
  getCloudflareContext,
  getDurableObjectIdentity,
} from "@flue/runtime/cloudflare"
