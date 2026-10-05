/**
 * A local stand-in for Resend's `POST /emails` (ADR 0023), so integration checks
 * exercise the real HTTP mailer without a Resend account. It answers like Resend:
 * 401 without the expected Bearer key, 422 for a missing field, `{ id }` otherwise.
 * It proves the request contract only; real delivery needs the external setup
 * recorded in ADR 0023.
 */
export interface SentEmail {
  id: string
  from: string
  to: string[]
  subject: string
  text: string
  html: string
  idempotencyKey: string | null
}

export function startResendStandIn(apiKey = 're_test_stand_in') {
  const sent: SentEmail[] = []
  let failure: number | null = null
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method !== 'POST' || url.pathname !== '/emails') return Response.json({ statusCode: 404, name: 'not_found', message: 'Not found' }, { status: 404 })
      if (request.headers.get('authorization') !== `Bearer ${apiKey}`) return Response.json({ statusCode: 401, name: 'missing_api_key', message: 'API key is invalid' }, { status: 401 })
      if (failure !== null) return Response.json({ statusCode: failure, name: 'application_error', message: 'Stand-in delivery failure' }, { status: failure })
      const body = await request.json().catch(() => null) as Record<string, unknown> | null
      const to = typeof body?.to === 'string' ? [body.to] : body?.to
      if (!body || typeof body.from !== 'string' || !Array.isArray(to) || typeof body.subject !== 'string' || (typeof body.html !== 'string' && typeof body.text !== 'string')) {
        return Response.json({ statusCode: 422, name: 'validation_error', message: 'Missing required field' }, { status: 422 })
      }
      const email: SentEmail = {
        id: crypto.randomUUID(), from: body.from, to: to as string[], subject: body.subject,
        text: String(body.text ?? ''), html: String(body.html ?? ''), idempotencyKey: request.headers.get('idempotency-key'),
      }
      sent.push(email)
      return Response.json({ id: email.id })
    },
  })
  return {
    apiKey,
    url: `http://127.0.0.1:${server.port}`,
    sent,
    /** Makes every following request fail with this status, or succeed again with null. */
    fail(status: number | null) { failure = status },
    /** The one link in the latest email to `to` with the given subject prefix. */
    linkTo(to: string, subjectPrefix: string) {
      const email = sent.filter((e) => e.to.some((address) => address.toLowerCase() === to.toLowerCase()) && e.subject.startsWith(subjectPrefix)).at(-1)
      return email ? /https?:\/\/\S+/.exec(email.text)?.[0] ?? null : null
    },
    stop: () => server.stop(true),
  }
}
