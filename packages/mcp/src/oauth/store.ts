import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs"
import { join } from "node:path"

export interface RegisteredClient {
  client_id: string
  redirect_uris: string[]
  client_name?: string
  registered_at: number
}

export interface AuthorizationCode {
  code: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  code_challenge_method: "S256"
  scope: string
  jwt: string
  refresh_token: string | null
  user_email: string
  user_id: string
  csrf_token: string
  expires_at: number
}

export interface AccessTokenRecord {
  access_token: string
  client_id: string
  jwt: string
  refresh_token: string | null
  user_email: string
  user_id: string
  scope: string
  expires_at: number
}

export interface OAuthRefreshTokenRecord {
  refresh_token: string
  client_id: string
  jwt: string
  refresh_token_upstream: string | null
  user_email: string
  user_id: string
  scope: string
  expires_at: number
}

const CODE_TTL_MS = 5 * 60 * 1000
const ACCESS_TOKEN_TTL_MS = 24 * 60 * 60 * 1000
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000

/*
  Encryption key strategy.

  Persistence requires a stable key — a per-boot key would render the on-disk
  blob unreadable after restart. Source precedence:
    1. MCP_OAUTH_ENC_KEY env var (base64-encoded 32 bytes). Preferred for prod.
    2. Generated and stored at <storeDir>/.key on first boot with mode 0600.
    3. Ephemeral random key (when persistence is disabled).
*/
const STORE_DIR = process.env["MCP_OAUTH_STORE_DIR"] ?? ""
const PERSIST = STORE_DIR.length > 0

function loadOrCreateKey(): Buffer {
  const envKey = process.env["MCP_OAUTH_ENC_KEY"]
  if (envKey && envKey.length > 0) {
    const buf = Buffer.from(envKey, "base64")
    if (buf.length !== 32) {
      throw new Error("MCP_OAUTH_ENC_KEY must decode to 32 bytes (base64-encoded)")
    }
    return buf
  }
  if (!PERSIST) return randomBytes(32)
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
  const keyPath = join(STORE_DIR, ".key")
  if (existsSync(keyPath)) {
    const buf = readFileSync(keyPath)
    if (buf.length === 32) return buf
  }
  const fresh = randomBytes(32)
  writeFileSync(keyPath, fresh, { mode: 0o600 })
  return fresh
}

const ENCRYPTION_KEY = loadOrCreateKey()

function encryptString(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("base64url")}.${encrypted.toString("base64url")}.${tag.toString("base64url")}`
}

function decryptString(encrypted: string): string {
  const parts = encrypted.split(".")
  if (parts.length !== 3) throw new Error("malformed encrypted token")
  const iv = Buffer.from(parts[0]!, "base64url")
  const data = Buffer.from(parts[1]!, "base64url")
  const tag = Buffer.from(parts[2]!, "base64url")
  const decipher = createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8")
}

const clients = new Map<string, RegisteredClient>()
const codes = new Map<string, AuthorizationCode>()
const accessTokens = new Map<string, AccessTokenRecord>()
const refreshTokens = new Map<string, OAuthRefreshTokenRecord>()

/*
  Disk persistence for clients, access tokens, and refresh tokens.

  Authorization codes are deliberately omitted: they live for 5 minutes and
  exist mid-handshake; if a restart drops them the user just retries the
  consent flow. CSRF tokens are likewise ephemeral.

  Records are written in their encrypted form (JWTs and refresh tokens stay
  ciphertext on disk). The plaintext file is a JSON object with already-encrypted
  string fields — opening the file leaks no credentials without the key.
*/
const STORE_FILE = PERSIST ? join(STORE_DIR, "oauth-state.json") : ""

interface PersistedState {
  clients: RegisteredClient[]
  accessTokens: AccessTokenRecord[]
  refreshTokens: OAuthRefreshTokenRecord[]
}

function loadState(): void {
  if (!PERSIST || !existsSync(STORE_FILE)) return
  const raw = readFileSync(STORE_FILE, "utf8")
  const parsed = JSON.parse(raw) as PersistedState
  const now = Date.now()
  for (const c of parsed.clients ?? []) clients.set(c.client_id, c)
  for (const a of parsed.accessTokens ?? []) {
    if (now <= a.expires_at) accessTokens.set(a.access_token, a)
  }
  for (const r of parsed.refreshTokens ?? []) {
    if (now <= r.expires_at) refreshTokens.set(r.refresh_token, r)
  }
}

function saveState(): void {
  if (!PERSIST) return
  const state: PersistedState = {
    clients: [...clients.values()],
    accessTokens: [...accessTokens.values()],
    refreshTokens: [...refreshTokens.values()],
  }
  mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${STORE_FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
  renameSync(tmp, STORE_FILE)
  chmodSync(STORE_FILE, 0o600)
}

loadState()

function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`
}

export function registerClient(input: { redirect_uris: string[]; client_name?: string }): RegisteredClient {
  const record: RegisteredClient = {
    client_id: newToken("ss_client"),
    redirect_uris: input.redirect_uris,
    client_name: input.client_name,
    registered_at: Date.now(),
  }
  clients.set(record.client_id, record)
  saveState()
  return record
}

export function getClient(client_id: string): RegisteredClient | undefined {
  return clients.get(client_id)
}

export function generateCsrfToken(): string {
  return randomBytes(32).toString("base64url")
}

export function issueAuthorizationCode(input: {
  client_id: string
  redirect_uri: string
  code_challenge: string
  scope: string
  jwt: string
  refresh_token: string | null
  user_email: string
  user_id: string
  csrf_token: string
}): string {
  const code = newToken("ss_code")
  codes.set(code, {
    code,
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge,
    code_challenge_method: "S256",
    scope: input.scope,
    jwt: encryptString(input.jwt),
    refresh_token: input.refresh_token ? encryptString(input.refresh_token) : null,
    user_email: input.user_email,
    user_id: input.user_id,
    csrf_token: input.csrf_token,
    expires_at: Date.now() + CODE_TTL_MS,
  })
  return code
}

export function consumeAuthorizationCode(
  code: string,
): (Omit<AuthorizationCode, "jwt" | "refresh_token"> & { jwt: string; refresh_token: string | null }) | undefined {
  const record = codes.get(code)
  if (!record) return undefined
  codes.delete(code)
  if (Date.now() > record.expires_at) return undefined
  try {
    return {
      ...record,
      jwt: decryptString(record.jwt),
      refresh_token: record.refresh_token ? decryptString(record.refresh_token) : null,
    }
  } catch {
    return undefined
  }
}

export function issueAccessToken(input: {
  client_id: string
  jwt: string
  refresh_token: string | null
  user_email: string
  user_id: string
  scope: string
}): { access_token: string; refresh_token: string | null; expires_in: number; refresh_expires_in: number } {
  const access_token = newToken("ss_at")
  const expires_at = Date.now() + ACCESS_TOKEN_TTL_MS
  accessTokens.set(access_token, {
    access_token,
    client_id: input.client_id,
    jwt: encryptString(input.jwt),
    refresh_token: input.refresh_token ? encryptString(input.refresh_token) : null,
    user_email: input.user_email,
    user_id: input.user_id,
    scope: input.scope,
    expires_at,
  })

  let oauthRefresh: string | null = null
  if (input.refresh_token) {
    oauthRefresh = newToken("ss_rt")
    refreshTokens.set(oauthRefresh, {
      refresh_token: oauthRefresh,
      client_id: input.client_id,
      jwt: encryptString(input.jwt),
      refresh_token_upstream: encryptString(input.refresh_token),
      user_email: input.user_email,
      user_id: input.user_id,
      scope: input.scope,
      expires_at: Date.now() + REFRESH_TOKEN_TTL_MS,
    })
  }

  saveState()
  return {
    access_token,
    refresh_token: oauthRefresh,
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_expires_in: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  }
}

export function lookupAccessToken(
  token: string,
): (Omit<AccessTokenRecord, "jwt" | "refresh_token"> & { jwt: string; refresh_token: string | null }) | undefined {
  const record = accessTokens.get(token)
  if (!record) return undefined
  if (Date.now() > record.expires_at) {
    accessTokens.delete(token)
    saveState()
    return undefined
  }
  try {
    return {
      ...record,
      jwt: decryptString(record.jwt),
      refresh_token: record.refresh_token ? decryptString(record.refresh_token) : null,
    }
  } catch {
    accessTokens.delete(token)
    saveState()
    return undefined
  }
}

/*
  Update the upstream JWT on an existing access-token record after a successful
  SendSquared refresh. Keeps the same opaque ss_at_* so the connector doesn't
  need to know a new token was minted; only the underlying credential rotates.
*/
export function updateAccessTokenJwt(token: string, newJwt: string): void {
  const record = accessTokens.get(token)
  if (!record) return
  record.jwt = encryptString(newJwt)
  accessTokens.set(token, record)
  saveState()
}

export function lookupRefreshToken(
  token: string,
): (Omit<OAuthRefreshTokenRecord, "jwt" | "refresh_token_upstream"> & { jwt: string; refresh_token_upstream: string | null }) | undefined {
  const record = refreshTokens.get(token)
  if (!record) return undefined
  if (Date.now() > record.expires_at) {
    refreshTokens.delete(token)
    saveState()
    return undefined
  }
  try {
    return {
      ...record,
      jwt: decryptString(record.jwt),
      refresh_token_upstream: record.refresh_token_upstream ? decryptString(record.refresh_token_upstream) : null,
    }
  } catch {
    refreshTokens.delete(token)
    saveState()
    return undefined
  }
}

/*
  OAuth refresh-token rotation: when the client redeems a refresh token at
  /oauth/token, we issue a fresh ss_rt_* and a fresh ss_at_*, and revoke the
  old refresh token. Reusing a revoked refresh token signals theft and would
  be rejected. The SendSquared upstream refresh token is carried forward
  unchanged (the SendSquared API does not rotate refresh tokens).
*/
export function rotateRefreshToken(
  oldToken: string,
  input: { jwt: string; refresh_token_upstream: string | null },
): { access_token: string; refresh_token: string; expires_in: number; refresh_expires_in: number } | undefined {
  const old = refreshTokens.get(oldToken)
  if (!old) return undefined
  if (Date.now() > old.expires_at) {
    refreshTokens.delete(oldToken)
    saveState()
    return undefined
  }
  refreshTokens.delete(oldToken)

  const access_token = newToken("ss_at")
  const refresh_token = newToken("ss_rt")
  accessTokens.set(access_token, {
    access_token,
    client_id: old.client_id,
    jwt: encryptString(input.jwt),
    refresh_token: input.refresh_token_upstream ? encryptString(input.refresh_token_upstream) : null,
    user_email: old.user_email,
    user_id: old.user_id,
    scope: old.scope,
    expires_at: Date.now() + ACCESS_TOKEN_TTL_MS,
  })
  refreshTokens.set(refresh_token, {
    refresh_token,
    client_id: old.client_id,
    jwt: encryptString(input.jwt),
    refresh_token_upstream: input.refresh_token_upstream ? encryptString(input.refresh_token_upstream) : null,
    user_email: old.user_email,
    user_id: old.user_id,
    scope: old.scope,
    expires_at: Date.now() + REFRESH_TOKEN_TTL_MS,
  })
  saveState()
  return {
    access_token,
    refresh_token,
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_expires_in: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
  }
}

export function isOpaqueAccessToken(token: string): boolean {
  return token.startsWith("ss_at_")
}

export function clientCount(): number {
  return clients.size
}

const sweepHandle = setInterval(() => {
  const now = Date.now()
  let mutated = false
  for (const [k, v] of codes) if (now > v.expires_at) { codes.delete(k); mutated = true }
  for (const [k, v] of accessTokens) if (now > v.expires_at) { accessTokens.delete(k); mutated = true }
  for (const [k, v] of refreshTokens) if (now > v.expires_at) { refreshTokens.delete(k); mutated = true }
  if (mutated) saveState()
}, 5 * 60 * 1000)
sweepHandle.unref()
