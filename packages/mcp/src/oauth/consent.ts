import type { RegisteredClient } from "./store.js"

export interface ConsentParams {
  client: RegisteredClient
  redirect_uri: string
  state: string
  code_challenge: string
  scope: string
  csrf_token: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function renderConsentPage(params: ConsentParams): string {
  const clientName = escapeHtml(params.client.client_name ?? "Unknown application")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect SendSquared</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.5; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #555; font-size: 14px; margin: 8px 0; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  textarea { width: 100%; min-height: 120px; padding: 10px 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; border: 1px solid #ccc; border-radius: 6px; resize: vertical; }
  button { margin-top: 16px; background: #2563eb; color: white; border: none; padding: 11px 22px; border-radius: 6px; font-size: 15px; font-weight: 500; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .client-card { background: #f8f8f8; border: 1px solid #e5e5e5; border-radius: 6px; padding: 12px 14px; margin: 16px 0 20px; font-size: 13px; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #888; }
</style>
</head>
<body>
  <h1>Connect SendSquared</h1>
  <p>An external application is requesting access to your SendSquared account.</p>
  <div class="client-card">
    <strong>${clientName}</strong>
  </div>
  <p>To authorize, paste a SendSquared session token below. For best results (stays signed in), run:</p>
  <p><code>sendsquared auth login &amp;&amp; sendsquared auth connector-token</code></p>
  <p>The <code>connector-token</code> command outputs a JSON blob that lets this server refresh your session automatically. A plain JWT from <code>sendsquared auth token</code> also works but will expire and require re-authentication.</p>
  <form method="POST" action="/oauth/authorize/submit">
    <input type="hidden" name="client_id" value="${escapeHtml(params.client.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirect_uri)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.code_challenge)}">
    <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrf_token)}">
    <textarea name="jwt" placeholder='{"jwt":"eyJhbGc...","refreshToken":"..."}   or just eyJhbGc...' required autofocus spellcheck="false" autocomplete="off"></textarea>
    <button type="submit">Connect</button>
  </form>
  <div class="footer">
    The token authorizes ${clientName} to act on your behalf in SendSquared. Tokens are encrypted at rest on this server.
  </div>
</body>
</html>`
}

export function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SendSquared connector error</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .err { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; padding: 14px; border-radius: 6px; font-size: 14px; }
</style>
</head>
<body>
  <h1>Connection failed</h1>
  <div class="err">${escapeHtml(message)}</div>
</body>
</html>`
}
