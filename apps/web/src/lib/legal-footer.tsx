import { Link } from "@tanstack/react-router"

export function LegalFooter() {
  return (
    <footer className="mx-auto flex max-w-3xl gap-4 px-6 py-6 text-muted-foreground text-sm">
      <Link className="hover:text-foreground" to="/privacy">
        Privacy
      </Link>
      <Link className="hover:text-foreground" to="/terms">
        Terms
      </Link>
    </footer>
  )
}
