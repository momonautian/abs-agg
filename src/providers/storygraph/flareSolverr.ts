import { httpClient } from '../../utils/httpClient'

export interface FlareSolverrCookie {
  name: string
  value: string
  domain?: string
  path?: string
}

export interface FlareSolverrSolution {
  url: string
  status: number
  cookies: FlareSolverrCookie[]
  userAgent: string
  response: string
}

const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191/v1'
const MAX_TIMEOUT_MS = Number(process.env.FLARESOLVERR_MAX_TIMEOUT || 90000)

/**
 * Ask FlareSolverr to fetch a URL, transparently solving any Cloudflare
 * challenge it encounters along the way.
 */
export async function solveWithFlareSolverr(url: string): Promise<FlareSolverrSolution> {
  let res: { data: any }

  try {
    res = await httpClient.post(
      FLARESOLVERR_URL,
      {
        cmd: 'request.get',
        url,
        maxTimeout: MAX_TIMEOUT_MS
      },
      {
        timeout: MAX_TIMEOUT_MS + 15000,
        headers: { 'Content-Type': 'application/json' }
      }
    )
  } catch (error: any) {
    const detail =
      error?.response?.data?.message || error?.message || String(error)
    throw new Error(`FlareSolverr unreachable at ${FLARESOLVERR_URL}: ${detail}`)
  }

  const data = res.data
  if (!data || data.status !== 'ok' || !data.solution) {
    throw new Error(`FlareSolverr failed: ${data?.message || 'unknown error'}`)
  }

  return data.solution as FlareSolverrSolution
}

/** Serialise FlareSolverr's cookie array into a Cookie header value. */
export function cookiesToHeader(cookies: FlareSolverrCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}
