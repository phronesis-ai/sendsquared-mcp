import type { RegisteredClient } from "./store.js"
import { SENDSQUARED_LOGO_SVG } from "./logo.js"

export interface ConsentParams {
  client: RegisteredClient
  redirect_uri: string
  state: string
  code_challenge: string
  scope: string
  csrf_token: string
  error?: string
  username?: string
}

export interface OtpParams extends ConsentParams {
  challenge_id: string
  method: string
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

const PAGE_STYLE = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 420px; margin: 60px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.5; }
  .logo { display: block; margin: 0 0 28px; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  p { color: #555; font-size: 14px; margin: 8px 0; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 14px 0 4px; }
  input[type=email], input[type=password], input[type=text] { width: 100%; padding: 10px 12px; font-size: 15px; border: 1px solid #ccc; border-radius: 6px; }
  code { background: #f0f0f0; padding: 2px 6px; border-radius: 3px; font-size: 12.5px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  textarea { width: 100%; min-height: 96px; padding: 10px 12px; font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; border: 1px solid #ccc; border-radius: 6px; resize: vertical; }
  button { margin-top: 18px; width: 100%; background: #2563eb; color: white; border: none; padding: 11px 22px; border-radius: 6px; font-size: 15px; font-weight: 500; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .client-card { background: #f8f8f8; border: 1px solid #e5e5e5; border-radius: 6px; padding: 12px 14px; margin: 16px 0 8px; font-size: 13px; }
  .err { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; padding: 10px 12px; border-radius: 6px; font-size: 13.5px; margin: 14px 0 0; }
  details { margin-top: 22px; font-size: 13px; color: #555; }
  summary { cursor: pointer; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #eee; font-size: 12px; color: #888; }
`

function hiddenFields(params: ConsentParams): string {
  return `
    <input type="hidden" name="client_id" value="${escapeHtml(params.client.client_id)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirect_uri)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.code_challenge)}">
    <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
    <input type="hidden" name="csrf_token" value="${escapeHtml(params.csrf_token)}">`
}

function errorBlock(error: string | undefined): string {
  return error ? `<div class="err" role="alert">${escapeHtml(error)}</div>` : ""
}

/*
  The sign-in form posts the email and password to this server, which signs
  in against the SendSquared API and keeps only the resulting session; the
  password is never stored or logged. Pasting a token from the CLI still works
  and sits behind a disclosure for people who already use it. Both forms need
  their own copy of the hidden OAuth fields because only one is submitted.
*/
export function renderConsentPage(params: ConsentParams): string {
  const clientName = escapeHtml(params.client.client_name ?? "An application")
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect SendSquared</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  ${SENDSQUARED_LOGO_SVG}
  <h1>Connect SendSquared</h1>
  <p>Sign in to let this application work with your SendSquared account.</p>
  <div class="client-card">
    <strong>${clientName}</strong>
  </div>
  ${errorBlock(params.error)}
  <form method="POST" action="/oauth/authorize/submit" autocomplete="on">
    ${hiddenFields(params)}
    <label for="username">Email</label>
    <input id="username" name="username" type="email" autocomplete="username" value="${escapeHtml(params.username ?? "")}" required autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in and connect</button>
  </form>
  <details>
    <summary>Use a token from the SendSquared CLI instead</summary>
    <p>Run <code>sendsquared auth login &amp;&amp; sendsquared auth connector-token</code> and paste the output.</p>
    <form method="POST" action="/oauth/authorize/submit">
      ${hiddenFields(params)}
      <textarea name="jwt" placeholder='{"jwt":"eyJhbGc...","refreshToken":"..."}   or just eyJhbGc...' required spellcheck="false" autocomplete="off"></textarea>
      <button type="submit">Connect with token</button>
    </form>
  </details>
  <div class="footer">
    Signing in authorizes ${clientName} to act on your behalf in SendSquared. Your password is sent to SendSquared to sign you in and is not stored here; the resulting session is encrypted at rest on this server.
  </div>
</body>
</html>`
}

export function renderOtpPage(params: OtpParams): string {
  const clientName = escapeHtml(params.client.client_name ?? "An application")
  const where = params.method === "sms" ? "sent to your phone" : params.method === "email" ? "sent to your email" : "from your authenticator"
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect SendSquared</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
  ${SENDSQUARED_LOGO_SVG}
  <h1>Enter your verification code</h1>
  <p>Your account uses two-step sign-in. Enter the code ${where} to finish connecting ${clientName}.</p>
  ${errorBlock(params.error)}
  <form method="POST" action="/oauth/authorize/otp" autocomplete="off">
    ${hiddenFields(params)}
    <input type="hidden" name="challenge_id" value="${escapeHtml(params.challenge_id)}">
    <input type="hidden" name="method" value="${escapeHtml(params.method)}">
    <label for="otp">Verification code</label>
    <input id="otp" name="otp" type="text" inputmode="numeric" autocomplete="one-time-code" required autofocus>
    <button type="submit">Verify and connect</button>
  </form>
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
  .logo { display: block; margin: 0 0 28px; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  .err { background: #fee2e2; border: 1px solid #fca5a5; color: #991b1b; padding: 14px; border-radius: 6px; font-size: 14px; }
</style>
</head>
<body>
  ${SENDSQUARED_LOGO_SVG}
  <h1>Connection failed</h1>
  <div class="err">${escapeHtml(message)}</div>
</body>
</html>`
}
