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
import { loginPassword, loginOtp, LoginError } from "@sendsquared/client"
import { renderConsentPage, renderOtpPage, renderErrorPage, type ConsentParams } from "./consent.js"

const SENDSQUARED_API_URL = process.env["SENDSQUARED_API_URL"] ?? "https://api.sendsquared.com"

/*
  OAuth 2.1 + PKCE flow with security hardening:

    - redirect_uri allowlist: only the assistant platforms the connector is
      listed on (Claude, ChatGPT), localhost, and any origin named in
      OAUTH_EXTRA_REDIRECT_ORIGINS are permitted as redirect targets. Prevents
      code-theft via malicious clients.
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
  /^https:\/\/chatgpt\.com(\/|$)/,
  /^https:\/\/[a-z0-9-]+\.chatgpt\.com(\/|$)/,
  /^https:\/\/[a-z0-9-]+\.openai\.com(\/|$)/,
  /^http:\/\/localhost(:\d+)?(\/|$)/,
  /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/,
]

const MAX_REGISTERED_CLIENTS = 500

/*
  Other assistant platforms redirect to origins that are only known once they
  first try to register, so they are added by config rather than a deploy:
  OAUTH_EXTRA_REDIRECT_ORIGINS is a comma-separated list of exact https
  origins. Rejected URIs are logged so the origin to add is visible.
*/
function extraRedirectOrigins(): string[] {
  return (process.env["OAUTH_EXTRA_REDIRECT_ORIGINS"] ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter((o) => o.startsWith("https://"))
}

function isRedirectUriAllowed(uri: string): boolean {
  if (ALLOWED_REDIRECT_PATTERNS.some((pattern) => pattern.test(uri))) {
    return true
  }
  return extraRedirectOrigins().some((origin) => uri === origin || uri.startsWith(`${origin}/`))
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
      console.log(`[oauth] register rejected redirect_uri=${uri}`)
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
    htmlError(res, 400, "Unknown client_id. The OAuth client may have been registered against a previous deployment of this server. Remove and re-add the SendSquared connector in your assistant to register a fresh client.")
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

interface AuthorizeRequest {
  client_id: string
  redirect_uri: string
  state: string
  code_challenge: string
  scope: string
  csrf_token: string
}

function authorizeRequestFrom(body: Record<string, unknown>): AuthorizeRequest {
  return {
    client_id: String(body["client_id"] ?? ""),
    redirect_uri: String(body["redirect_uri"] ?? ""),
    state: String(body["state"] ?? ""),
    code_challenge: String(body["code_challenge"] ?? ""),
    scope: String(body["scope"] ?? "mcp"),
    csrf_token: String(body["csrf_token"] ?? ""),
  }
}

/*
  Every form post on the sign-in pages goes through the same gate: a single
  use CSRF token, then the client and redirect checks. A retry (wrong
  password, wrong code) is answered with a freshly rendered page carrying a
  new CSRF token rather than a dead-end error.
*/
function authorizeGate(req: AuthorizeRequest, res: Response): ConsentParams | undefined {
  const csrfValid = req.csrf_token.length > 0 && consumeCsrfToken(req.csrf_token)
  if (!csrfValid) {
    console.log(`[oauth] CSRF check failed. token_length=${req.csrf_token.length} map_size=${csrfTokens.size}`)
    htmlError(res, 403, "Session expired. Please close this window and reconnect the SendSquared connector.")
    return undefined
  }
  if (!req.client_id || !req.redirect_uri || !req.code_challenge) {
    htmlError(res, 400, "Missing required OAuth parameters.")
    return undefined
  }
  const client = getClient(req.client_id)
  if (!client) {
    htmlError(res, 400, "Unknown client_id.")
    return undefined
  }
  if (!client.redirect_uris.includes(req.redirect_uri)) {
    htmlError(res, 400, "redirect_uri mismatch.")
    return undefined
  }
  if (!isRedirectUriAllowed(req.redirect_uri)) {
    htmlError(res, 400, "redirect_uri is not in the server's allowlist.")
    return undefined
  }
  return {
    client,
    redirect_uri: req.redirect_uri,
    state: req.state,
    code_challenge: req.code_challenge,
    scope: req.scope,
    csrf_token: issueCsrfToken(),
  }
}

interface SignedIn {
  jwt: string
  refreshToken: string | null
  user_email: string
  user_id: string
}

function redirectWithCode(res: Response, req: AuthorizeRequest, signedIn: SignedIn): void {
  const code = issueAuthorizationCode({
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    scope: req.scope,
    jwt: signedIn.jwt,
    refresh_token: signedIn.refreshToken,
    user_email: signedIn.user_email,
    user_id: signedIn.user_id,
    csrf_token: req.csrf_token,
  })
  const url = new URL(req.redirect_uri)
  url.searchParams.set("code", code)
  if (req.state) url.searchParams.set("state", req.state)
  res.redirect(302, url.toString())
}

function sendPage(res: Response, status: number, html: string): void {
  setSecurityHeaders(res)
  res.status(status).type("html").send(html)
}

/*
  A 4xx from the login API is the user's input being wrong; anything else
  (5xx, network failure) is the API being unavailable, and telling the user
  their password is wrong then would send them off to reset it for nothing.
*/
function signInFailure(err: unknown, rejected: string): { status: number; message: string; detail: string } {
  const detail = err instanceof Error ? err.message : String(err)
  if (err instanceof LoginError && err.status >= 400 && err.status < 500) {
    return { status: 401, message: rejected, detail }
  }
  return { status: 502, message: "SendSquared sign-in isn't available right now. Please try again in a few minutes.", detail }
}

const signInLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: () => SKIP_RATE_LIMIT,
  message: { error: "too_many_requests", error_description: "Too many sign-in attempts. Wait a minute and try again." },
})

/*
  Two ways in: an email and password, which this server exchanges for a
  SendSquared session through the same login the web app uses (with a code
  step when the account has two-step sign-in), or a token pasted from the
  CLI. The password only passes through to the API; it is never logged or
  kept, and the request log records field names, not values.
*/
oauthRouter.post("/authorize/submit", signInLimiter, async (req, res) => {
  console.log(`[oauth] POST /authorize/submit content-type=${req.headers["content-type"]} body_keys=${Object.keys(req.body ?? {}).join(",")}`)
  const body = (req.body ?? {}) as Record<string, unknown>
  const request = authorizeRequestFrom(body)
  const page = authorizeGate(request, res)
  if (!page) {
    return
  }

  const username = String(body["username"] ?? "").trim()
  const password = String(body["password"] ?? "")
  if (username.length > 0 || password.length > 0) {
    if (username.length === 0 || password.length === 0) {
      sendPage(res, 400, renderConsentPage({ ...page, username, error: "Enter both your email and password." }))
      return
    }
    let result
    try {
      result = await loginPassword(SENDSQUARED_API_URL, username, password)
    } catch (err) {
      const failure = signInFailure(err, "That email and password didn't work. Check them and try again.")
      console.log(`[oauth] password sign-in failed: ${failure.detail}`)
      sendPage(res, failure.status, renderConsentPage({ ...page, username, error: failure.message }))
      return
    }
    switch (result.kind) {
      case "mfa":
        sendPage(res, 200, renderOtpPage({ ...page, challenge_id: result.challenge.id, method: result.challenge.method }))
        return
      case "ok":
        redirectWithCode(res, request, {
          jwt: result.session.jwt,
          refreshToken: result.session.refreshToken || null,
          user_email: result.session.email,
          user_id: String(result.session.userId),
        })
        return
    }
  }

  const parsed = parsePastedToken(String(body["jwt"] ?? ""))
  if (!parsed) {
    sendPage(res, 400, renderConsentPage({ ...page, error: "Enter your email and password, or paste a token from the SendSquared CLI." }))
    return
  }
  const profile = await lookupProfile(parsed.jwt)
  if (!profile.ok) {
    htmlError(res, 400, profile.error ?? "Token validation failed.")
    return
  }
  redirectWithCode(res, request, {
    jwt: parsed.jwt,
    refreshToken: parsed.refreshToken,
    user_email: profile.user_email!,
    user_id: profile.user_id!,
  })
})

oauthRouter.post("/authorize/otp", signInLimiter, async (req, res) => {
  console.log(`[oauth] POST /authorize/otp body_keys=${Object.keys(req.body ?? {}).join(",")}`)
  const body = (req.body ?? {}) as Record<string, unknown>
  const request = authorizeRequestFrom(body)
  const page = authorizeGate(request, res)
  if (!page) {
    return
  }
  const challenge_id = String(body["challenge_id"] ?? "")
  const method = String(body["method"] ?? "")
  const otp = String(body["otp"] ?? "").replace(/\s+/g, "")
  if (challenge_id.length === 0 || otp.length === 0) {
    sendPage(res, 400, renderOtpPage({ ...page, challenge_id, method, error: "Enter the verification code." }))
    return
  }
  let session
  try {
    session = await loginOtp(SENDSQUARED_API_URL, challenge_id, otp)
  } catch (err) {
    const failure = signInFailure(err, "That code didn't work. Check it and try again.")
    console.log(`[oauth] otp sign-in failed: ${failure.detail}`)
    sendPage(res, failure.status, renderOtpPage({ ...page, challenge_id, method, error: failure.message }))
    return
  }
  redirectWithCode(res, request, {
    jwt: session.jwt,
    refreshToken: session.refreshToken || null,
    user_email: session.email,
    user_id: String(session.userId),
  })
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
