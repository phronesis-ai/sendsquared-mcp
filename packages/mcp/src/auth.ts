import { createHash } from "node:crypto"
import type { Request } from "express"
import { isOpaqueAccessToken, lookupAccessToken } from "./oauth/store.js"
import { refreshSendsquaredJwt } from "./oauth/refresh.js"

export interface ValidatedProfile {
  userId: string
  email: string
  companyId: number
  validatedAt: number
}

export interface AuthError {
  status: number
  message: string
}

export type ValidationResult =
  | { ok: true; profile: ValidatedProfile; effectiveJwt: string }
  | { ok: false; error: AuthError }

const CACHE_TTL_MS = 5 * 60 * 1000

/*
  Cache is keyed by SHA-256(JWT), not the raw bearer the request arrived with.
  This means a JWT validated through the Claude Code path (raw JWT in the
  Authorization header) and the same JWT looked up via an OAuth opaque token
  (claude.ai path) share cache hits — the underlying credential is the same.
  TTL is 5 minutes; on 401 from any downstream call we drop the entry so a
  revoked JWT loses access on the next request.
*/
const cache = new Map<string, ValidatedProfile>()

function hashJwt(jwt: string): string {
  return createHash("sha256").update(jwt).digest("hex")
}

export function extractBearer(req: Request): string | null {
  const header = req.headers["authorization"]
  if (!header || typeof header !== "string") return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return null
  return match[1]!.trim()
}

/*
  Decode a JWT's payload WITHOUT verifying the signature (the upstream API
  handles signature verification). We only need the exp claim to reject
  obviously-expired tokens before wasting a round-trip or trusting a cache
  entry that was written when the JWT was still valid.
*/
export function jwtExpiredLocally(jwt: string): boolean {
  const parts = jwt.split(".")
  if (parts.length !== 3) return false
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8")
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const exp = typeof parsed["exp"] === "number" ? parsed["exp"] : 0
    if (exp === 0) return false
    return Date.now() > exp * 1000
  } catch {
    return false
  }
}

export async function validateToken(
  bearer: string,
  baseUrl: string,
): Promise<ValidationResult> {
  let jwt = bearer
  let opaqueToken: string | null = null

  if (isOpaqueAccessToken(bearer)) {
    opaqueToken = bearer
    const record = lookupAccessToken(bearer)
    if (!record) {
      return {
        ok: false,
        error: {
          status: 401,
          message: "OAuth access token is invalid or expired. Reconnect the SendSquared connector to refresh.",
        },
      }
    }
    jwt = record.jwt
  }

  /*
    If the JWT has expired locally and this is an opaque-token request, try to
    refresh it transparently using the stored SendSquared refresh token. If
    refresh succeeds we proceed with the new JWT; if it fails (refresh token
    expired or no refresh token was captured) we surface 401 and the user
    re-authenticates.
  */
  if (jwtExpiredLocally(jwt)) {
    cache.delete(hashJwt(jwt))
    if (opaqueToken) {
      const refreshed = await refreshSendsquaredJwt(opaqueToken, baseUrl)
      if (refreshed) {
        jwt = refreshed
      } else {
        return {
          ok: false,
          error: {
            status: 401,
            message: "SendSquared session expired and could not be refreshed. Reconnect the connector in claude.ai.",
          },
        }
      }
    } else {
      return {
        ok: false,
        error: {
          status: 401,
          message: "SendSquared token has expired. Run `sendsquared auth login && sendsquared auth token` and re-paste, or reconnect the connector in claude.ai.",
        },
      }
    }
  }

  const key = hashJwt(jwt)
  const cached = cache.get(key)
  if (cached && Date.now() - cached.validatedAt < CACHE_TTL_MS) {
    return { ok: true, profile: cached, effectiveJwt: jwt }
  }

  let res = await fetch(`${baseUrl}/v1/user/`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  })

  /*
    If the API rejects a JWT that looked good locally (clock skew, server-side
    revocation, etc.) and we have an opaque-token path with a refresh token,
    try one more refresh+retry before failing the user.
  */
  if ((res.status === 401 || res.status === 403) && opaqueToken) {
    cache.delete(key)
    const refreshed = await refreshSendsquaredJwt(opaqueToken, baseUrl)
    if (refreshed && refreshed !== jwt) {
      jwt = refreshed
      res = await fetch(`${baseUrl}/v1/user/`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
        },
      })
    }
  }

  if (res.status === 401 || res.status === 403) {
    cache.delete(key)
    return {
      ok: false,
      error: {
        status: 401,
        message: "SendSquared token is invalid or expired. Run `sendsquared auth login && sendsquared auth token` and re-paste, or reconnect the connector in claude.ai.",
      },
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      error: {
        status: 502,
        message: `SendSquared API returned ${res.status} while validating the token.`,
      },
    }
  }

  const body = (await res.json()) as Record<string, unknown>

  let companyId = 0
  try {
    const parts = jwt.split(".")
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>
      companyId = typeof payload["company_id"] === "number" ? payload["company_id"] : 0
    }
  } catch { /* ignore — companyId stays 0 */ }

  const profile: ValidatedProfile = {
    userId: String(body["id"] ?? ""),
    email: String(body["email"] ?? ""),
    companyId,
    validatedAt: Date.now(),
  }

  if (!profile.userId) {
    return {
      ok: false,
      error: {
        status: 502,
        message: "SendSquared /v1/user/ response was missing the user id.",
      },
    }
  }

  cache.set(hashJwt(jwt), profile)
  return { ok: true, profile, effectiveJwt: jwt }
}

export function invalidateJwt(jwt: string): void {
  cache.delete(hashJwt(jwt))
}
