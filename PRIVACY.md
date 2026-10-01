# SendSquared MCP Connector — Privacy Policy

Last updated: 2026-04-21

This document describes how the SendSquared MCP connector (`mcp.sendsquared.com`) and the SendSquared Claude plugin handle data. The canonical, legally-binding policy is published at https://sendsquared.com/privacy; this file is a summary for Anthropic directory reviewers and developers.

## Data we receive through the connector

When you use the connector in Claude or Claude Code, the following flow through our servers:

- **Your SendSquared JWT** (or opaque access token derived from it). Used to authenticate your requests against the SendSquared API. Stored server-side only for the duration of an OAuth session; never logged.
- **Tool-call arguments and results.** Claude may send contact, reservation, campaign, template, and other business data as part of a tool call. We proxy these to the SendSquared API and return the response. Request/response bodies are not persisted beyond transient logs (request ID, status, error class) used for debugging.
- **Your user-agent, IP address, and timestamps** at the edge, for abuse prevention and rate-limiting.

## Data we do NOT receive

- We do not see the rest of your Claude conversation — only the tool calls the assistant makes.
- We do not store message content from your SendSquared account beyond what is needed to answer the current tool call.

## How data is used

- To execute the tool call you requested against the SendSquared API.
- To enforce per-token rate limits and detect abuse.
- To produce short-lived operational metrics (request counts by tool, error rates). No business-data contents are included.

## Third-party sharing

- SendSquared itself is the backing service. No other third parties receive data from the connector.
- We do not sell, rent, or share your data for advertising or training.

## Data retention

- Access tokens: expire after the configured OAuth session lifetime; rotated on refresh.
- Transient request logs: retained up to 30 days, then purged.
- Business data (contacts, reservations, etc.): not retained by the connector; it lives in your SendSquared tenant.

## Your rights

Because the connector is a thin proxy, all data subject rights (access, export, deletion) are exercised in your SendSquared account — see https://sendsquared.com/privacy for the full policy and the support contact to invoke those rights.

## Contact

support@sendsquared.com — general support and privacy questions.
security@sendsquared.com — security issues, responsible disclosure.
