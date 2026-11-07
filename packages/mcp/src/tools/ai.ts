import { AI_CONSTRAINTS, aiAgentBody, assertContextTypes, aiContextBody, aiSessionFilters, aiSessionStats, type AiAgentInput, type AiContextInput } from "@sendsquared/client"
import { apiForRequest, envelope, asString, asOptString, asOptNumber, asOptBoolean } from "./shared.js"
import type { ToolDefinition } from "./types.js"

type Row = Record<string, unknown>

function idArg(args: Row, name: string): string {
  const value = args[name]
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value)
  }
  return asString(value, name)
}

function stringList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`${name} must be an array of strings`)
  }
  return value as string[]
}

function agentInput(args: Row): AiAgentInput {
  return {
    name: asOptString(args["name"]),
    escalationThreshold: asOptNumber(args["escalation_threshold"]),
    active: asOptBoolean(args["active"]),
    maxSteps: asOptNumber(args["max_steps"]),
    maxTurns: asOptNumber(args["max_turns"]),
    maxRetries: asOptNumber(args["max_retries"]),
    voice: asOptString(args["voice"]),
    personality: asOptString(args["personality"]),
    greeting: asOptString(args["greeting"]),
    systemPrompt: asOptString(args["system_prompt"]),
    contextTypes: stringList(args["context_types"], "context_types"),
  }
}

function contextInput(args: Row): AiContextInput {
  return {
    label: asOptString(args["label"]),
    contextType: asOptString(args["context_type"]),
    systemPrompt: asOptString(args["system_prompt"]),
    description: asOptString(args["description"]),
    requirements: asOptString(args["requirements"]),
    verifications: asOptString(args["verifications"]),
    constraints: stringList(args["constraints"], "constraints"),
  }
}

const AGENT_PROPS = {
  escalation_threshold: { type: "number", description: "0-100, likelihood of escalation at which the agent hands off to a person (default 50)" },
  active: { type: "boolean" },
  max_steps: { type: "number", description: "Tool steps per turn (default 5)" },
  max_turns: { type: "number", description: "Turns per session (default 20)" },
  max_retries: { type: "number", description: "Retries on errors (default 3)" },
  voice: { type: "string", description: "Text-to-speech voice id for voice calls" },
  personality: { type: "string" },
  greeting: { type: "string", description: "Opening message" },
  system_prompt: { type: "string" },
  context_types: { type: "array", items: { type: "string" }, description: "Context types the agent may enter (sendsquared_ai_contexts_config); replaces the set" },
}

const CONTEXT_PROPS = {
  label: { type: "string", description: "Display name" },
  context_type: { type: "string", description: "Unique slug: lowercase letters, digits, underscores" },
  description: { type: "string", description: "What requests belong here; the AI uses it to classify a conversation" },
  system_prompt: { type: "string", description: "System prompt used while in this context" },
  requirements: { type: "string", description: "Markdown: information the AI should gather (soft, enforced by the model)" },
  verifications: { type: "string", description: "Markdown verification steps" },
  constraints: { type: "array", items: { type: "string", enum: AI_CONSTRAINTS } },
}

async function contextConfig(): Promise<Row[]> {
  return ((await apiForRequest().get("/ai-context-types/config/")) ?? []) as Row[]
}

function agentSummary(agent: Row): Row {
  return { id: agent["id"], name: agent["name"], active: agent["active"], escalation_threshold: agent["escalation_threshold"], context_types: agent["context_types"], voice: agent["voice"] ?? null }
}

function sessionSummary(s: Row): Row {
  return {
    id: s["id"],
    created_at: s["created_at"],
    contact_id: s["contact_id"],
    unit_id: s["unit_id"],
    last_context_type: s["last_context_type"],
    turns: s["turns"],
    escalated: Boolean(s["is_escalate"]),
    complete: Boolean(s["is_complete"]),
    resolved: Boolean(s["is_resolved"]),
    handled_by_id: s["handled_by_id"] ?? null,
    spend_cents: s["spend"],
  }
}

export const aiAgentsList: ToolDefinition = {
  name: "sendsquared_ai_agents_list",
  description: "List the SendSquared AI agents (the assistants that answer guests over SMS and voice): name, active flag, escalation threshold and allowed context types.",
  inputSchema: { type: "object", properties: { limit: { type: "number", default: 100 }, after_id: { type: "number", default: 0 } } },
  handler: async (args) => {
    const data = await apiForRequest().list<Row>("/ai-agents/", { limit: asOptNumber(args["limit"]) ?? 100, after_id: asOptNumber(args["after_id"]) ?? 0 })
    return envelope({ agents: data.data.map(agentSummary), total: data.total }, `${data.total} AI agents`, ["sendsquared_ai_agents_get", "sendsquared_ai_agents_create"])
  },
}

export const aiAgentsGet: ToolDefinition = {
  name: "sendsquared_ai_agents_get",
  description: "Get an AI agent with its full personality, greeting and system prompt.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    const data = ((await apiForRequest().get(`/ai-agents/${encodeURIComponent(id)}`)) ?? {}) as Row
    return envelope(data, `AI agent ${id}: ${String(data["name"] ?? "")}`, ["sendsquared_ai_agents_update"])
  },
}

export const aiAgentsCreate: ToolDefinition = {
  name: "sendsquared_ai_agents_create",
  description: "Create an AI agent. Defaults match the web form: escalation threshold 50, 5 steps, 20 turns, 3 retries, active. Context types are validated against sendsquared_ai_contexts_config.",
  inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, ...AGENT_PROPS } },
  handler: async (args) => {
    const input = agentInput(args)
    if (input.contextTypes) {
      assertContextTypes(input.contextTypes, await contextConfig())
    }
    const data = ((await apiForRequest().post("/ai-agents/", aiAgentBody(undefined, input))) ?? {}) as Row
    return envelope(data, `AI agent created: ${String(input.name)}`, ["sendsquared_ai_agents_get"])
  },
}

export const aiAgentsUpdate: ToolDefinition = {
  name: "sendsquared_ai_agents_update",
  description: "Change an AI agent; only the fields passed change (the current record is read first, because the API replaces every field on write). context_types replaces the whole set.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, name: { type: "string" }, ...AGENT_PROPS } },
  handler: async (args) => {
    const id = idArg(args, "id")
    const api = apiForRequest()
    const current = ((await api.get(`/ai-agents/${encodeURIComponent(id)}`)) ?? {}) as Row
    const input = agentInput(args)
    if (input.contextTypes) {
      assertContextTypes(input.contextTypes, await contextConfig())
    }
    const data = ((await api.put(`/ai-agents/${encodeURIComponent(id)}`, aiAgentBody(current, input))) ?? {}) as Row
    return envelope(data, `AI agent ${id} updated`)
  },
}

export const aiAgentsDelete: ToolDefinition = {
  name: "sendsquared_ai_agents_delete",
  description: "Delete an AI agent. Destructive — there is no undo; conversations routed to it stop being answered by AI.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    await apiForRequest().delete(`/ai-agents/${encodeURIComponent(id)}`)
    return envelope(null, `AI agent ${id} deleted`, ["sendsquared_ai_agents_list"])
  },
}

const SESSION_FILTER_PROPS = {
  escalated: { type: "boolean", description: "Only escalated (true) or not (false)" },
  complete: { type: "boolean" },
  resolved: { type: "boolean" },
  handled: { type: "boolean", description: "Handled by a person" },
  contact_id: { type: "number" },
  unit_id: { type: "number" },
  since: { type: "string", description: "Created on or after, YYYY-MM-DD or ISO" },
  until: { type: "string", description: "Created on or before" },
}

function sessionQuery(args: Row, limit: number, afterId: number) {
  return {
    limit,
    after_id: afterId,
    filter: aiSessionFilters({
      escalated: asOptBoolean(args["escalated"]),
      complete: asOptBoolean(args["complete"]),
      resolved: asOptBoolean(args["resolved"]),
      handled: asOptBoolean(args["handled"]),
      contactId: asOptNumber(args["contact_id"]),
      unitId: asOptNumber(args["unit_id"]),
      since: asOptString(args["since"]),
      until: asOptString(args["until"]),
    }),
    sort: ["id:desc"],
  }
}

export const aiSessionsList: ToolDefinition = {
  name: "sendsquared_ai_sessions_list",
  description: "List AI conversation sessions, newest first: contact, unit, last context, turns, whether escalated / complete / resolved / handled, and spend. Read-only.",
  inputSchema: { type: "object", properties: { limit: { type: "number", default: 50 }, after_id: { type: "number", default: 0 }, ...SESSION_FILTER_PROPS } },
  handler: async (args) => {
    const data = await apiForRequest().list<Row>("/ai-sessions/", sessionQuery(args, asOptNumber(args["limit"]) ?? 50, asOptNumber(args["after_id"]) ?? 0))
    return envelope({ sessions: data.data.map(sessionSummary), total: data.total }, `${data.total} AI sessions`, ["sendsquared_ai_sessions_get", "sendsquared_ai_sessions_stats"])
  },
}

export const aiSessionsGet: ToolDefinition = {
  name: "sendsquared_ai_sessions_get",
  description: "Get one AI session: context, tool use, turns, errors, tokens, spend, escalation and handling timestamps.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    return envelope(await apiForRequest().get(`/ai-sessions/${encodeURIComponent(id)}`), `AI session ${id}`)
  },
}

export const aiSessionsStats: ToolDefinition = {
  name: "sendsquared_ai_sessions_stats",
  description: "Usage totals over matching AI sessions: session count, escalated / complete / resolved / handled counts, turns, errors, tokens, spend in cents, and sessions per context type.",
  inputSchema: { type: "object", properties: { limit: { type: "number", default: 1000, description: "Max sessions to aggregate" }, ...SESSION_FILTER_PROPS } },
  handler: async (args) => {
    const data = await apiForRequest().list<Row>("/ai-sessions/", sessionQuery(args, asOptNumber(args["limit"]) ?? 1000, 0))
    const stats = aiSessionStats(data.data)
    return envelope(stats, `${stats.sessions} sessions: ${stats.escalated} escalated, ${stats.complete} complete, $${(stats.spend_cents / 100).toFixed(2)} spend`)
  },
}

export const aiContextsList: ToolDefinition = {
  name: "sendsquared_ai_contexts_list",
  description: "List this company's custom AI context types: the kinds of request an agent classifies a conversation into, each with its own prompt and constraints.",
  inputSchema: { type: "object", properties: { search: { type: "string", description: "Match in label or slug" }, limit: { type: "number", default: 100 }, after_id: { type: "number", default: 0 } } },
  handler: async (args) => {
    const q = asOptString(args["search"])?.replace(/:/g, "").trim()
    const data = await apiForRequest().list<Row>("/ai-context-types/", {
      limit: asOptNumber(args["limit"]) ?? 100,
      after_id: asOptNumber(args["after_id"]) ?? 0,
      filter: q ? [`label:ilike:%${q}%:or`, `context_type:ilike:%${q}%:or`] : undefined,
    })
    return envelope({ contexts: data.data, total: data.total }, `${data.total} custom context types`, ["sendsquared_ai_contexts_config", "sendsquared_ai_contexts_create"])
  },
}

export const aiContextsConfig: ToolDefinition = {
  name: "sendsquared_ai_contexts_config",
  description: "Every context type an agent can be given: the built-in ones (guest_service, maintenance, reservation, inquiry) plus this company's custom ones. Knowledge lookups happen in the inquiry context.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await contextConfig()
    return envelope(data, `${data.length} context types available`, ["sendsquared_ai_agents_update"])
  },
}

export const aiContextsGet: ToolDefinition = {
  name: "sendsquared_ai_contexts_get",
  description: "Get a custom AI context type with its prompt, requirements, verifications and constraints.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    return envelope(await apiForRequest().get(`/ai-context-types/${encodeURIComponent(id)}`), `Context type ${id}`)
  },
}

export const aiContextsCreate: ToolDefinition = {
  name: "sendsquared_ai_contexts_create",
  description: "Create a custom AI context type. label, context_type (slug), description and system_prompt are required; the slug is checked for collisions with built-in and existing types.",
  inputSchema: { type: "object", required: ["label", "context_type", "description", "system_prompt"], properties: CONTEXT_PROPS },
  handler: async (args) => {
    const body = aiContextBody(undefined, contextInput(args))
    if ((await contextConfig()).some((c) => c["context_type"] === body["context_type"])) {
      throw new Error(`context type "${String(body["context_type"])}" already exists`)
    }
    const data = ((await apiForRequest().post("/ai-context-types/", body)) ?? {}) as Row
    return envelope(data, `Context type created: ${String(body["label"])}`, ["sendsquared_ai_agents_update"])
  },
}

export const aiContextsUpdate: ToolDefinition = {
  name: "sendsquared_ai_contexts_update",
  description: "Change a custom AI context type; only the fields passed change (the current record is read first, because the API replaces every field on write).",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, ...CONTEXT_PROPS } },
  handler: async (args) => {
    const id = idArg(args, "id")
    const api = apiForRequest()
    const current = ((await api.get(`/ai-context-types/${encodeURIComponent(id)}`)) ?? {}) as Row
    const data = ((await api.put(`/ai-context-types/${encodeURIComponent(id)}`, aiContextBody(current, contextInput(args)))) ?? {}) as Row
    return envelope(data, `Context type ${id} updated`)
  },
}

export const aiContextsDelete: ToolDefinition = {
  name: "sendsquared_ai_contexts_delete",
  description: "Delete a custom AI context type. Destructive — there is no undo; agents that listed it lose that context.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    await apiForRequest().delete(`/ai-context-types/${encodeURIComponent(id)}`)
    return envelope(null, `Context type ${id} deleted`, ["sendsquared_ai_contexts_list"])
  },
}

export const aiTools: ToolDefinition[] = [
  aiAgentsList,
  aiAgentsGet,
  aiAgentsCreate,
  aiAgentsUpdate,
  aiAgentsDelete,
  aiSessionsList,
  aiSessionsGet,
  aiSessionsStats,
  aiContextsList,
  aiContextsConfig,
  aiContextsGet,
  aiContextsCreate,
  aiContextsUpdate,
  aiContextsDelete,
]
