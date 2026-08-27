import { createFileRoute } from "@tanstack/react-router"
import { signOut } from "@workos/authkit-tanstack-react-start"
import { LoadingState } from "@workspace/ui/components/loading-state"
import { abandonFlow } from "@/lib/auth/actions"

export const Route = createFileRoute("/sign-out")({
  // In the loader, where the kit's own docs put it: `signOut` ends in a
  // redirect, and a redirect thrown from a loader is handled, where one thrown
  // from a click handler is not. It is safe when nobody is signed in — the kit
  // returns a plain return-to rather than failing — so this page is idempotent
  // and a second visit is a no-op.
  loader: async () => {
    await abandonFlow()
    await signOut({ data: { returnTo: "/" } })
  },
  component: () => <LoadingState className="m-6" label="Signing you out" />,
})
