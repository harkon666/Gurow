/** Anything that answers requests like the served backend (`createServer(...).request`). */
interface Server {
  request: (input: string, init: RequestInit) => Response | Promise<Response>
}

/**
 * A browser talking to the served backend from `origin`: it keeps the cookies the
 * server sets, drops expired ones, and sends the rest back on every request, as a
 * same-origin fetch would. `server` is read per request, so a suite may replace it.
 */
export class CookieBrowser {
  cookies = new Map<string, string>()
  constructor(private readonly server: () => Server, private readonly origin: string) {}

  async request(path: string, { method = 'GET', body, headers = {} }: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const response = await this.server().request(new URL(path, this.origin).toString(), {
      method,
      redirect: 'manual',
      headers: {
        origin: this.origin,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookies.size ? { cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';')
      const [name, value] = [pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1)]
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === ''
      if (expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
}
