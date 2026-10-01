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

  const body = (await res.json()) as Record<string, unknown>

  if (!res.ok) {
    throw new Error((body["message"] as string) ?? `Login failed: ${res.status}`)
  }

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

  const body = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    throw new Error((body["message"] as string) ?? `MFA failed: ${res.status}`)
  }

  return parseLoginResponse(body)
}

/*
  POST /login/refresh-token answers with the new JWT as a bare JSON string —
  not an object. Reading body.jwt off it yields undefined, which then gets
  persisted over the stored credentials and logs the user out on the first
  token expiry. The object form is still accepted in case the endpoint grows
  an envelope, and an unusable response throws rather than being written back.
*/
export async function refreshAuthToken(baseUrl: string, token: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/login/refresh-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: token }),
  })

  const body = (await res.json()) as unknown

  if (!res.ok) {
    const message =
      body && typeof body === "object" ? (body as Record<string, unknown>)["message"] : undefined
    throw new Error(typeof message === "string" ? message : `Token refresh failed: ${res.status}`)
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
