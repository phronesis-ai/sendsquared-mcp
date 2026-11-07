export interface LoginSession {
  jwt: string
  refreshToken: string
  email: string
  userId: string
  companyId: string
  companyName: string
  companies: Array<{ id: string; name: string }>
}

export interface MfaChallenge {
  id: string
  context: string
  method: string
}

export type LoginResult =
  | { kind: "ok"; session: LoginSession }
  | { kind: "mfa"; challenge: MfaChallenge }

export class LoginError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = "LoginError"
    this.status = status
  }
}

export class SessionExpiredError extends Error {
  readonly status: number
  readonly detail: string
  constructor(detail: string, status: number) {
    super(`SendSquared session expired or invalid (${detail})`)
    this.name = "SessionExpiredError"
    this.status = status
    this.detail = detail
  }
}

/*
  The login routes answer a failure with plain text ("Invalid username or
  password") rather than JSON, so the body is read as text and parsed only if
  it looks like JSON. The status rides along on the error so callers can tell
  a rejected sign-in (4xx) from the API being down (5xx).
*/
function parseJsonText(text: string): unknown {
  if (!/^\s*[{["]/.test(text)) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function errorMessage(body: unknown, text: string): string | undefined {
  const message = body && typeof body === "object" ? (body as Record<string, unknown>)["message"] : undefined
  if (typeof message === "string" && message.length > 0) return message
  return text.trim() || undefined
}

async function readLoginBody(res: Response, fallback: string): Promise<Record<string, unknown>> {
  const text = await res.text()
  const body = parseJsonText(text)
  if (!res.ok) {
    throw new LoginError(errorMessage(body, text) ?? `${fallback}: ${res.status}`, res.status)
  }
  if (!body || typeof body !== "object") {
    throw new LoginError(`${fallback}: unexpected response`, res.status)
  }
  return body as Record<string, unknown>
}

export async function loginPassword(
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginResult> {
  const res = await fetch(`${baseUrl}/v1/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, full_acls: true }),
  })

  const body = await readLoginBody(res, "Login failed")

  if (body["mfa_required"]) {
    return { kind: "mfa", challenge: body["mfa_required"] as MfaChallenge }
  }

  return { kind: "ok", session: parseLoginResponse(body) }
}

export async function loginOtp(
  baseUrl: string,
  challengeId: string,
  otp: string,
): Promise<LoginSession> {
  const res = await fetch(`${baseUrl}/v1/login/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ otp, id: challengeId, trust: true, full_acls: true }),
  })

  const body = await readLoginBody(res, "MFA failed")

  return parseLoginResponse(body)
}

/*
  POST /login/refresh-token answers with the new JWT as a bare JSON string —
  not an object. Reading body.jwt off it yields undefined, which then gets
  persisted over the stored credentials and logs the user out on the first
  token expiry. The object form is still accepted in case the endpoint grows
  an envelope, and an unusable response throws rather than being written back.

  A rejected refresh comes back as plain text ("Invalid refresh token"), so
  the body is read as text. Calling res.json() on it used to throw a JSON
  parse error that hid the real cause. A 4xx means the refresh token itself
  is dead, so it is raised as SessionExpiredError and callers can point the
  user at a fresh login. A 5xx is the API failing and stays a plain Error.
*/
export async function refreshAuthToken(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/login/refresh-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: token }),
  })

  const text = await res.text()
  const body = parseJsonText(text)

  if (!res.ok) {
    if (res.status >= 400 && res.status < 500) {
      throw new SessionExpiredError(errorMessage(body, text) ?? `HTTP ${res.status}`, res.status)
    }
    throw new Error(`Token refresh failed: ${res.status}`)
  }

  if (typeof body === "string" && body.length > 0) return body

  const jwt = body && typeof body === "object" ? (body as Record<string, unknown>)["jwt"] : undefined
  if (typeof jwt !== "string" || jwt.length === 0) {
    throw new Error("Token refresh returned no token. Run: sendsquared auth login")
  }
  return jwt
}

function parseLoginResponse(body: Record<string, unknown>): LoginSession {
  return {
    jwt: body["jwt"] as string,
    refreshToken: body["refreshToken"] as string,
    email: body["email"] as string,
    userId: body["userId"] as string,
    companyId: body["companyId"] as string,
    companyName: body["companyName"] as string,
    companies: (body["companies"] ?? []) as Array<{ id: string; name: string }>,
  }
}
