const HEADERS = {
  "cache-control": "no-store",
  "retry-after": "3600",
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'",
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname === "/geist.woff2")
      return env.ASSETS.fetch(new Request(request.url))
    const page = await env.ASSETS.fetch(new Request(new URL("/", request.url)))
    return new Response(page.body, {
      status: 503,
      headers: { "content-type": "text/html; charset=utf-8", ...HEADERS },
    })
  },
}
