import { refreshAuthToken } from "@sendsquared/client"
import { lookupAccessToken, updateAccessTokenJwt, lookupRefreshToken, rotateRefreshToken } from "./store.js"
import { jwtExpiredLocally } from "../auth.js"

/*
  Per-key promise-singleton locks (mirrors the ad-base-spa axiosWrapper
  pattern). When multiple concurrent requests notice an expired JWT, the
  first call to acquire the lock does the actual /v1/login/refresh-token
  round-trip; subsequent calls await the same promise and reuse the result.
  Without this we'd stampede the SendSquared API on every cache-miss burst.
*/
const locks = new Map<string, Promise<string | null>>()

async function withLock(key: string, fn: () => Promise<string | null>): Promise<string | null> {
  const existing = locks.get(key)
  if (existing) return existing
  const promise = fn().finally(() => locks.delete(key))
  locks.set(key, promise)
  return promise
}

/*
  Refresh the upstream SendSquared JWT for an opaque access token. Returns the
  new JWT on success, null if the refresh failed (token revoked, refresh token
  itself expired, etc.) — in which case the caller must surface a 401 and the
  user re-authenticates.
*/
export async function refreshSendsquaredJwt(accessToken: string, baseUrl: string): Promise<string | null> {
  return withLock(`at:${accessToken}`, async () => {
    const record = lookupAccessToken(accessToken)
    if (!record || !record.refresh_token) return null
    const newJwt = await refreshAuthToken(baseUrl, record.refresh_token).catch(() => null)
    if (!newJwt) return null
    updateAccessTokenJwt(accessToken, newJwt)
    return newJwt
  })
}

export type RefreshGrantResult =
  | {
      ok: true
      access_token: string
      refresh_token: string
      expires_in: number
      refresh_expires_in: number
      scope: string
    }
  | { ok: false; error: string; error_description: string }

/*
  Handle grant_type=refresh_token at /oauth/token. The OAuth refresh token is
  single-use — successful redemption rotates it. We also refresh the upstream
  SendSquared JWT opportunistically: if the stored JWT is close to expiry
  (or has already expired) we mint a new one before issuing the access token
  so the client gets a fresh credential.
*/
export async function refreshOauthAccess(
  refreshToken: string,
  clientId: string,
  baseUrl: string,
): Promise<RefreshGrantResult> {
  const record = lookupRefreshToken(refreshToken)
  if (!record) {
    return { ok: false, error: "invalid_grant", error_description: "Refresh token is invalid or expired" }
  }
  if (record.client_id !== clientId) {
    return { ok: false, error: "invalid_grant", error_description: "client_id does not match refresh token" }
  }

  /*
    Before minting new OAuth tokens we have to make sure the *underlying*
    SendSquared session is alive. Otherwise we return a healthy-looking
    access_token wrapped around a dead JWT and the client loops:
    OAuth refresh → 200 → first MCP call → 401 → another OAuth refresh → 200 →
    401 again, with the connector reporting "got new credentials, but
    sendsquared rejected them on reconnect."

    If we have an upstream refresh token, it MUST refresh successfully; if it
    doesn't, the SendSquared session is gone and the client should be told to
    re-authenticate fully. We also defensively reject locally-expired JWTs
    that somehow survived (e.g. legacy installs with no upstream refresh
    token whose JWT has aged out).
  */
  let jwt = record.jwt
  if (record.refresh_token_upstream) {
    const refreshed = await refreshAuthToken(baseUrl, record.refresh_token_upstream).catch(() => null)
    if (!refreshed) {
      return {
        ok: false,
        error: "invalid_grant",
        error_description: "SendSquared session refresh failed; please re-authenticate the connector.",
      }
    }
    jwt = refreshed
  }
  if (jwtExpiredLocally(jwt)) {
    return {
      ok: false,
      error: "invalid_grant",
      error_description: "SendSquared session has expired; please re-authenticate the connector.",
    }
  }

  const rotated = rotateRefreshToken(refreshToken, {
    jwt,
    refresh_token_upstream: record.refresh_token_upstream,
  })
  if (!rotated) {
    return { ok: false, error: "invalid_grant", error_description: "Refresh token could not be rotated" }
  }

  return {
    ok: true,
    access_token: rotated.access_token,
    refresh_token: rotated.refresh_token,
    expires_in: rotated.expires_in,
    refresh_expires_in: rotated.refresh_expires_in,
    scope: record.scope,
  }
}
