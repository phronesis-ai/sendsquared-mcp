import express, { type Request, type Response, type NextFunction } from "express"
import { randomUUID } from "node:crypto"
import rateLimit from "express-rate-limit"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { buildMcpServer } from "./server.js"
import { requestContext, type RequestContext } from "./context.js"
import { extractBearer, validateToken, invalidateJwt } from "./auth.js"
import { perTokenRateLimit } from "./rateLimit.js"
import { oauthRouter } from "./oauth/routes.js"
import { buildAuthServerMetadata, buildProtectedResourceMetadata } from "./oauth/metadata.js"

const PORT = Number(process.env["PORT"] ?? 8080)
const SENDSQUARED_API_URL = process.env["SENDSQUARED_API_URL"] ?? "https://api.sendsquared.com"
const PUBLIC_BASE_URL = process.env["PUBLIC_BASE_URL"] ?? "https://mcp.sendsquared.com"
const CLI_BASE_URL = process.env["CLI_BASE_URL"] ?? "https://cli.sendsquared.com"

const app = express()
app.use(express.json({ limit: "4mb" }))
app.use(express.urlencoded({ extended: false, limit: "1mb" }))

app.set("trust proxy", 1)

app.use((_req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
  res.setHeader("X-Content-Type-Options", "nosniff")
  next()
})

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Global rate limit exceeded (300 req/min per IP)" },
})

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true })
})

/*
  The CLI is distributed from cli.sendsquared.com now. These redirects keep
  older installs working: their self-update still fetches the bundle from the
  MCP host, and any docs that point at the old installer still resolve.
*/
app.get("/install.sh", (_req, res) => {
  res.redirect(301, `${CLI_BASE_URL}/install.sh`)
})

app.get("/cli/sendsquared", (_req, res) => {
  res.redirect(301, `${CLI_BASE_URL}/sendsquared`)
})

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
  res.json(buildAuthServerMetadata(PUBLIC_BASE_URL))
})

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json(buildProtectedResourceMetadata(PUBLIC_BASE_URL))
})

app.use("/oauth", oauthRouter)

/*
  Stateful MCP session tracking. Claude.ai's connector protocol opens a session
  with an initialize request, then sends tool calls under the same mcp-session-id
  header. We keep one StreamableHTTPServerTransport per session id, AND we build
  a fresh Server instance for each session. The MCP SDK's Server.connect() is
  single-use — calling it twice on the same Server throws — so we cannot share
  one Server across sessions. Per-request auth still flows through
  AsyncLocalStorage, not through the server instance, so the per-session Server
  is essentially identical for every session and only exists to satisfy the
  one-Server-per-Transport contract.
*/
const transports: Record<string, StreamableHTTPServerTransport> = {}
const sessionLastSeen: Record<string, number> = {}

const SESSION_TTL_MS = 30 * 60 * 1000
const sessionSweep = setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS
  for (const [id, lastSeen] of Object.entries(sessionLastSeen)) {
    if (lastSeen < cutoff) {
      delete transports[id]
      delete sessionLastSeen[id]
    }
  }
}, 5 * 60 * 1000)
sessionSweep.unref()

async function authenticate(req: Request): Promise<
  { ok: true; ctx: RequestContext } | { ok: false; status: number; message: string }
> {
  const bearer = extractBearer(req)
  if (!bearer) {
    return { ok: false, status: 401, message: "Missing Authorization: Bearer <token> header" }
  }
  const result = await validateToken(bearer, SENDSQUARED_API_URL)
  if (!result.ok) {
    return { ok: false, status: result.error.status, message: result.error.message }
  }
  return {
    ok: true,
    ctx: {
      token: result.effectiveJwt,
      userId: result.profile.userId,
      email: result.profile.email,
      companyId: result.profile.companyId,
      baseUrl: SENDSQUARED_API_URL,
    },
  }
}

/*
  RFC 6750 / MCP auth spec: a 401 from a protected resource server should
  carry a WWW-Authenticate header pointing the client at the protected resource
  metadata document. claude.ai uses this to discover the OAuth provider and
  kick off a re-authorization flow when a token expires.
*/
function setAuthChallenge(res: Response): void {
  res.setHeader(
    "WWW-Authenticate",
    `Bearer realm="sendsquared-mcp", resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
  )
}

function respondJsonRpcError(res: Response, code: number, message: string, id: unknown = null): void {
  const status = code === -32000 ? 429 : code === -32001 ? 401 : 500
  if (status === 401) setAuthChallenge(res)
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id,
  })
}

app.post(
  "/mcp",
  globalLimiter,
  perTokenRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    const auth = await authenticate(req)
    if (!auth.ok) {
      console.log(`[auth] REJECTED status=${auth.status} message="${auth.message.slice(0, 100)}"`)
      respondJsonRpcError(res, -32001, auth.message, req.body?.id ?? null)
      return
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId]
      sessionLastSeen[sessionId] = Date.now()
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const sessionServer = buildMcpServer()
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport
          sessionLastSeen[id] = Date.now()
        },
      })
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports[transport.sessionId]
          delete sessionLastSeen[transport.sessionId]
        }
      }
      await sessionServer.connect(transport)
    } else {
      respondJsonRpcError(res, -32600, "Bad Request: no valid session id and not an initialize request", req.body?.id ?? null)
      return
    }

    requestContext.run(auth.ctx, async () => {
      await transport.handleRequest(req, res, req.body).catch((err: unknown) => {
        if (err instanceof Error && err.message.includes("401")) {
          invalidateJwt(auth.ctx.token)
        }
        next(err)
      })
    })
  },
)

async function handleSessionRequest(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session id")
    return
  }
  const auth = await authenticate(req)
  if (!auth.ok) {
    console.log(`[auth] REJECTED session=${sessionId} status=${auth.status} message="${auth.message.slice(0, 100)}"`)
    if (auth.status === 401) setAuthChallenge(res)
    res.status(auth.status).json({ error: auth.message })
    return
  }
  sessionLastSeen[sessionId] = Date.now()
  const transport = transports[sessionId]
  requestContext.run(auth.ctx, async () => {
    await transport.handleRequest(req, res)
  })
}

app.get("/mcp", globalLimiter, perTokenRateLimit, handleSessionRequest)
app.delete("/mcp", globalLimiter, perTokenRateLimit, handleSessionRequest)

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[sendsquared-mcp] unhandled error:", err.message)
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" })
  }
})

app.listen(PORT, () => {
  console.log(`[sendsquared-mcp] listening on port ${PORT}`)
  console.log(`[sendsquared-mcp] upstream: ${SENDSQUARED_API_URL}`)
})
