import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { Router, type Request, type Response } from "express"
import rateLimit from "express-rate-limit"
import {
  registerClient,
  getClient,
  issueAuthorizationCode,
  consumeAuthorizationCode,
  issueAccessToken,
  rotateRefreshToken,
  generateCsrfToken,
  clientCount,
} from "./store.js"
import { renderConsentPage, renderErrorPage } from "./consent.js"

const SENDSQUARED_API_URL = process.env["SENDSQUARED_API_URL"] ?? "https://api.sendsquared.com"

/*
  OAuth 2.1 + PKCE flow with security hardening:

    - redirect_uri allowlist: only claude.ai, anthropic.com, and localhost are
      permitted as redirect targets. Prevents code-theft via malicious clients.
    - CSRF on /authorize/submit: the consent page embeds a random token as a
      hidden field; the submit handler validates it matches what was stored when
      the page was rendered. Prevents cross-site form submission.
    - Rate-limited /register: 10 registrations per minute per IP. Prevents
      resource exhaustion via bulk client registration.
    - Encrypted JWT storage: JWTs stored in the in-memory code/token maps are
      AES-256-GCM encrypted with a per-boot ephemeral key (see store.ts).
    - PKCE S256 only: plain method rejected.
*/

const ALLOWED_REDIRECT_PATTERNS = [
  /^https:\/\/claude\.ai(\/|$)/,
  /^https:\/\/[a-z0-9-]+\.claude\.ai(\/|$)/,
  /^https:\/\/[a-z0-9-]+\.anthropic\.com(\/|$)/,
  /^http:\/\/localhost(:\d+)?(\/|$)/,
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
]

const MAX_REGISTERED_CLIENTS = 500

function isRedirectUriAllowed(uri: string): boolean {
  return ALLOWED_REDIRECT_PATTERNS.some((pattern) => pattern.test(uri))
}

interface ProfileLookup {
  ok: boolean
  user_email?: string
  user_id?: string
  error?: string
}

async function lookupProfile(jwt: string): Promise<ProfileLookup> {
  const res = await fetch(`${SENDSQUARED_API_URL}/v1/user/`, {
    method: "GET",
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
  })
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      error: "The token you pasted is invalid or expired. Run `sendsquared auth login && sendsquared auth token` again and try once more.",
    }
  }
  if (!res.ok) {
    return { ok: false, error: `SendSquared API returned ${res.status} while validating the token.` }
  }
  const body = (await res.json()) as Record<string, unknown>
  const user_id = String(body["id"] ?? "")
  const user_email = String(body["email"] ?? "")
  if (!user_id) {
    return { ok: false, error: "SendSquared /v1/user/ response was missing the user id." }
  }
  return { ok: true, user_id, user_email }
}

function jsonError(res: Response, status: number, error: string, error_description?: string): void {
  res.status(status).json({ error, error_description })
}

function setSecurityHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action *")
  res.setHeader("X-Content-Type-Options", "nosniff")
  res.setHeader("Referrer-Policy", "no-referrer")
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate")
  res.setHeader("Pragma", "no-cache")
}

function htmlError(res: Response, status: number, message: string): void {
  setSecurityHeaders(res)
  res.status(status).type("html").send(renderErrorPage(message))
}

function verifyPkceS256(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256").update(verifier).digest("base64url")
  const a = Buffer.from(hash)
  const b = Buffer.from(challenge)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const csrfTokens = new Map<string, number>()
const CSRF_TTL_MS = 10 * 60 * 1000
const MAX_CSRF_TOKENS = 5000

function issueCsrfToken(): string {
  if (csrfTokens.size >= MAX_CSRF_TOKENS) {
    const cutoff = Date.now() - CSRF_TTL_MS
    for (const [k, v] of csrfTokens) if (v < cutoff) csrfTokens.delete(k)
    if (csrfTokens.size >= MAX_CSRF_TOKENS) {
      const first = csrfTokens.keys().next().value
      if (first) csrfTokens.delete(first)
    }
  }
  const token = generateCsrfToken()
  csrfTokens.set(token, Date.now())
  return token
}

function consumeCsrfToken(token: string): boolean {
  const issued = csrfTokens.get(token)
  if (issued === undefined) return false
  csrfTokens.delete(token)
  if (Date.now() - issued > CSRF_TTL_MS) return false
  return true
}

const SKIP_RATE_LIMIT = process.env["NODE_ENV"] === "test"

const registrationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => SKIP_RATE_LIMIT,
  message: { error: "too_many_registrations", error_description: "Rate limit: max 10 client registrations per minute per IP" },
})

export const oauthRouter = Router()

oauthRouter.post("/register", registrationLimiter, (req, res) => {
  if (clientCount() >= MAX_REGISTERED_CLIENTS) {
    jsonError(res, 503, "server_error", "Maximum number of registered clients reached. The server may need to be restarted to clear stale registrations.")
    return
  }

  const body = (req.body ?? {}) as Record<string, unknown>
  const redirect_uris = body["redirect_uris"]

  if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    jsonError(res, 400, "invalid_redirect_uri", "redirect_uris is required and must be a non-empty array")
    return
  }
  for (const uri of redirect_uris) {
    if (typeof uri !== "string") {
      jsonError(res, 400, "invalid_redirect_uri", "each redirect_uri must be a string")
      return
    }
    if (!isRedirectUriAllowed(uri)) {
      jsonError(
        res,
        400,
        "invalid_redirect_uri",
        "redirect_uri is not permitted",
      )
      return
    }
  }

  const client = registerClient({
    redirect_uris: redirect_uris as string[],
    client_name: typeof body["client_name"] === "string" ? (body["client_name"] as string) : undefined,
  })

  res.status(201).json({
    client_id: client.client_id,
    client_id_issued_at: Math.floor(client.registered_at / 1000),
    redirect_uris: client.redirect_uris,
    client_name: client.client_name,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  })
})

const authorizeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => SKIP_RATE_LIMIT,
  message: { error: "too_many_requests", error_description: "Rate limit: max 20 authorization requests per minute per IP" },
})

oauthRouter.get("/authorize", authorizeLimiter, (req, res) => {
  console.log(`[oauth] GET /authorize client_id=${req.query["client_id"]} redirect_uri=${req.query["redirect_uri"]}`)
  const q = req.query as Record<string, string | undefined>
  const client_id = q["client_id"]
  const redirect_uri = q["redirect_uri"]
  const response_type = q["response_type"]
  const code_challenge = q["code_challenge"]
  const code_challenge_method = q["code_challenge_method"]
  const state = q["state"] ?? ""
  const scope = q["scope"] ?? "mcp"

  if (!client_id || !redirect_uri || !code_challenge) {
    htmlError(res, 400, "Missing required OAuth parameters: client_id, redirect_uri, and code_challenge are all required.")
    return
  }
  if (response_type !== "code") {
    htmlError(res, 400, `response_type must be "code" (got "${response_type ?? ""}").`)
    return
  }
  if (code_challenge_method !== "S256") {
    htmlError(res, 400, `code_challenge_method must be "S256" (got "${code_challenge_method ?? ""}").`)
    return
  }

  const client = getClient(client_id)
  if (!client) {
    htmlError(res, 400, "Unknown client_id. The OAuth client may have been registered against a previous deployment of this server. Remove and re-add the connector in claude.ai to register a fresh client.")
    return
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    htmlError(res, 400, "redirect_uri does not match any URI registered for this client.")
    return
  }
  if (!isRedirectUriAllowed(redirect_uri)) {
    htmlError(res, 400, "redirect_uri is not in the server's allowlist.")
    return
  }

  const csrf_token = issueCsrfToken()

  setSecurityHeaders(res)
  res.type("html").send(
    renderConsentPage({
      client,
      redirect_uri,
      state,
      code_challenge,
      scope,
      csrf_token,
    }),
  )
})

/*
  The consent textarea accepts either a raw JWT (legacy `sendsquared auth token`)
  or a JSON blob `{jwt, refreshToken}` from `sendsquared auth connector-token`.
  Only the JSON form lets us refresh silently. We tolerate both so existing
  setups keep working — they just expire and need re-paste on JWT death.
*/
function parsePastedToken(raw: string): { jwt: string; refreshToken: string | null } | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const jwt = typeof parsed["jwt"] === "string" ? (parsed["jwt"] as string).trim() : ""
      const rt = typeof parsed["refreshToken"] === "string" ? (parsed["refreshToken"] as string).trim() : ""
      if (!jwt) return null
      return { jwt, refreshToken: rt.length > 0 ? rt : null }
    } catch {
      return null
    }
  }
  return { jwt: trimmed, refreshToken: null }
}

oauthRouter.post("/authorize/submit", async (req, res) => {
  console.log(`[oauth] POST /authorize/submit content-type=${req.headers["content-type"]} body_keys=${Object.keys(req.body ?? {}).join(",")}`)
  const body = (req.body ?? {}) as Record<string, unknown>
  const client_id = String(body["client_id"] ?? "")
  const redirect_uri = String(body["redirect_uri"] ?? "")
  const state = String(body["state"] ?? "")
  const code_challenge = String(body["code_challenge"] ?? "")
  const scope = String(body["scope"] ?? "mcp")
  const pasted = String(body["jwt"] ?? "")
  const csrf_token = String(body["csrf_token"] ?? "")

  const csrfValid = csrf_token.length > 0 && consumeCsrfToken(csrf_token)
  if (!csrfValid) {
    console.log(`[oauth] CSRF check failed. token_length=${csrf_token.length} map_size=${csrfTokens.size}`)
    htmlError(res, 403, "Session expired. Please close this window and reconnect the SendSquared connector.")
    return
  }

  const parsed = parsePastedToken(pasted)
  if (!client_id || !redirect_uri || !code_challenge || !parsed) {
    htmlError(res, 400, "Missing or unparseable token. Paste either a raw JWT or the JSON output from `sendsquared auth connector-token`.")
    return
  }
  const { jwt, refreshToken } = parsed

  const client = getClient(client_id)
  if (!client) {
    htmlError(res, 400, "Unknown client_id.")
    return
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    htmlError(res, 400, "redirect_uri mismatch.")
    return
  }
  if (!isRedirectUriAllowed(redirect_uri)) {
    htmlError(res, 400, "redirect_uri is not in the server's allowlist.")
    return
  }

  const profile = await lookupProfile(jwt)
  if (!profile.ok) {
    htmlError(res, 400, profile.error ?? "Token validation failed.")
    return
  }

  const code = issueAuthorizationCode({
    client_id,
    redirect_uri,
    code_challenge,
    scope,
    jwt,
    refresh_token: refreshToken,
    user_email: profile.user_email!,
    user_id: profile.user_id!,
    csrf_token,
  })

  const url = new URL(redirect_uri)
  url.searchParams.set("code", code)
  if (state) url.searchParams.set("state", state)

  res.redirect(302, url.toString())
})

oauthRouter.post("/token", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const grant_type = String(body["grant_type"] ?? "")

  if (grant_type === "authorization_code") {
    const code = String(body["code"] ?? "")
    const redirect_uri = String(body["redirect_uri"] ?? "")
    const client_id = String(body["client_id"] ?? "")
    const code_verifier = String(body["code_verifier"] ?? "")

    if (!code || !code_verifier || !client_id || !redirect_uri) {
      jsonError(res, 400, "invalid_request", "code, code_verifier, client_id, and redirect_uri are required")
      return
    }

    const record = consumeAuthorizationCode(code)
    if (!record) {
      jsonError(res, 400, "invalid_grant", "Authorization code is invalid, expired, or already used")
      return
    }
    if (record.client_id !== client_id) {
      jsonError(res, 400, "invalid_grant", "client_id does not match the authorization code")
      return
    }
    if (record.redirect_uri !== redirect_uri) {
      jsonError(res, 400, "invalid_grant", "redirect_uri does not match the authorization request")
      return
    }
    if (!verifyPkceS256(code_verifier, record.code_challenge)) {
      jsonError(res, 400, "invalid_grant", "PKCE verification failed (code_verifier does not match code_challenge)")
      return
    }

    const issued = issueAccessToken({
      client_id,
      jwt: record.jwt,
      refresh_token: record.refresh_token,
      user_email: record.user_email,
      user_id: record.user_id,
      scope: record.scope,
    })

    const payload: Record<string, unknown> = {
      access_token: issued.access_token,
      token_type: "Bearer",
      expires_in: issued.expires_in,
      scope: record.scope,
    }
    if (issued.refresh_token) {
      payload["refresh_token"] = issued.refresh_token
      payload["refresh_token_expires_in"] = issued.refresh_expires_in
    }
    res.json(payload)
    return
  }

  if (grant_type === "refresh_token") {
    const refresh_token = String(body["refresh_token"] ?? "")
    const client_id = String(body["client_id"] ?? "")
    if (!refresh_token || !client_id) {
      jsonError(res, 400, "invalid_request", "refresh_token and client_id are required")
      return
    }
    const { refreshOauthAccess } = await import("./refresh.js")
    const result = await refreshOauthAccess(refresh_token, client_id, SENDSQUARED_API_URL)
    if (!result.ok) {
      jsonError(res, 400, result.error, result.error_description)
      return
    }
    res.json({
      access_token: result.access_token,
      token_type: "Bearer",
      expires_in: result.expires_in,
      refresh_token: result.refresh_token,
      refresh_token_expires_in: result.refresh_expires_in,
      scope: result.scope,
    })
    return
  }

  jsonError(res, 400, "unsupported_grant_type", `Grant type "${grant_type}" is not supported (use authorization_code or refresh_token)`)
})

const csrfSweepHandle = setInterval(() => {
  const cutoff = Date.now() - CSRF_TTL_MS
  for (const [k, v] of csrfTokens) if (v < cutoff) csrfTokens.delete(k)
}, 60 * 1000)
csrfSweepHandle.unref()
