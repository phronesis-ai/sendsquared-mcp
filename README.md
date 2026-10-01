# SendSquared MCP server

A remote [Model Context Protocol](https://modelcontextprotocol.io) server for the
[SendSquared](https://www.sendsquared.com) hospitality CRM, plus the
`@sendsquared/client` library it is built on. It lets an AI assistant work with a
SendSquared account: contacts, groups and segments, campaigns, automations,
surveys, guidebooks, reservations, imports and reports.

The hosted endpoint is `https://mcp.sendsquared.com/mcp`. Every request carries a
SendSquared API token as `Authorization: Bearer <token>`; the server holds no
credentials of its own.

## Packages

| Package | What it is |
|---|---|
| `packages/client` | `@sendsquared/client` — typed HTTP client for the SendSquared API, token refresh, and the pure helpers (segment conditions, workflow steps, survey payloads, campaign and import logic) the tools are built from |
| `packages/mcp` | `@sendsquared/mcp-server` — Express + MCP Streamable HTTP server exposing the tools, prompts and skills |

## Running locally

```
npm install
npm run build --workspace @sendsquared/client
npm run dev            # MCP server on http://localhost:8080/mcp
```

Environment:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `SENDSQUARED_API_URL` | `https://api.sendsquared.com` | API the tools call |
| `PUBLIC_BASE_URL` | `https://mcp.sendsquared.com` | Base URL advertised to clients |

Health check: `GET /healthz`.

## Connecting a client

Point an MCP client at `https://mcp.sendsquared.com/mcp` with the header
`Authorization: Bearer <your SendSquared API token>`. Tokens come from the
SendSquared app, or from `sendsquared auth token` in the SendSquared CLI.

## Development

```
npm run typecheck
```

The test suite lives with the private CLI repo this package is developed in.

Tool annotations (`readOnlyHint`, `destructiveHint`) are derived from tool names
in `packages/mcp/src/tools/annotations.ts`; sending, deleting and merging are
marked destructive so clients confirm them.

## Privacy

See [PRIVACY.md](PRIVACY.md).
