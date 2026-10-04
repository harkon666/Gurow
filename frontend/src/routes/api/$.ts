import { createFileRoute } from '@tanstack/react-router'
// Brings in Start's server-route options for createFileRoute.
import type {} from '@tanstack/react-start'

/**
 * Forwards /api/* to the Hono backend so sign-in cookies stay first-party on the
 * application's own origin (ADR 0022). The backend origin is read at run time.
 */
const apiOrigin = () => process.env.GUROW_API_ORIGIN ?? 'http://127.0.0.1:3001'

async function forward({ request }: { request: Request }) {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('accept-encoding')
  const response = await fetch(new URL(url.pathname + url.search, apiOrigin()), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
    redirect: 'manual',
  })
  const forwarded = new Headers(response.headers)
  // fetch already decoded the body.
  forwarded.delete('content-encoding')
  forwarded.delete('content-length')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: forwarded })
}

export const Route = createFileRoute('/api/$')({ server: { handlers: { ANY: forward } } })
