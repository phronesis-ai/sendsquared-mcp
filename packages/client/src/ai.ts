export enum AiConstraint {
  RequireReservation = "requireReservation",
  ValidateReservation = "validateReservation",
  RequireLead = "requireLead",
  RequireTask = "requireTask",
  JsonOutput = "jsonOutput",
  TopicAlign = "topicAlign",
  Requirements = "requirements",
  Escalate = "escalate",
}

export const AI_CONSTRAINTS = Object.values(AiConstraint)

export const AI_AGENT_DEFAULTS = { escalation_threshold: 50, max_steps: 5, max_turns: 20, max_retries: 3, active: true }

export interface AiAgentInput {
  name?: string
  escalationThreshold?: number
  active?: boolean
  maxSteps?: number
  maxTurns?: number
  maxRetries?: number
  voice?: string
  personality?: string
  greeting?: string
  systemPrompt?: string
  contextTypes?: string[]
}

function intInRange(value: unknown, name: string, min: number, max?: number): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || (max !== undefined && n > max)) {
    throw new Error(`${name} must be a whole number ${max === undefined ? `of at least ${min}` : `between ${min} and ${max}`}`)
  }
  return n
}

/*
  PUT on an agent writes every column, so an update is the current record
  with the changes laid over it; sending only the changed fields would blank
  the rest and drop all of the agent's context types. Create starts from the
  web form's defaults.
*/
export function aiAgentBody(current: Record<string, unknown> | undefined, input: AiAgentInput): Record<string, unknown> {
  const base: Record<string, unknown> = current ? { ...current } : { ...AI_AGENT_DEFAULTS }
  for (const key of ["id", "company_id", "created_at", "modified_at", "deleted_at"]) {
    delete base[key]
  }
  const body: Record<string, unknown> = {
    name: input.name ?? base["name"],
    escalation_threshold: input.escalationThreshold ?? base["escalation_threshold"],
    active: input.active ?? base["active"],
    max_steps: input.maxSteps ?? base["max_steps"],
    max_turns: input.maxTurns ?? base["max_turns"],
    max_retries: input.maxRetries ?? base["max_retries"],
    voice: input.voice ?? base["voice"],
    personality: input.personality ?? base["personality"],
    greeting: input.greeting ?? base["greeting"],
    system_prompt: input.systemPrompt ?? base["system_prompt"],
    context_types: input.contextTypes ?? base["context_types"] ?? [],
  }
  if (typeof body["name"] !== "string" || body["name"].trim().length === 0) {
    throw new Error("name is required")
  }
  body["escalation_threshold"] = intInRange(body["escalation_threshold"], "escalation threshold", 0, 100)
  body["max_steps"] = intInRange(body["max_steps"], "max steps", 1)
  body["max_turns"] = intInRange(body["max_turns"], "max turns", 1)
  body["max_retries"] = intInRange(body["max_retries"], "max retries", 0)
  for (const key of ["voice", "personality", "greeting", "system_prompt"]) {
    if (body[key] === null) delete body[key]
  }
  return body
}

export function assertContextTypes(requested: string[], available: Array<Record<string, unknown>>): void {
  const known = new Set(available.map((c) => String(c["context_type"])))
  const unknown = requested.filter((c) => !known.has(c))
  if (unknown.length > 0) {
    throw new Error(`unknown context types: ${unknown.join(", ")} (see ai contexts config)`)
  }
}

export interface AiContextInput {
  label?: string
  contextType?: string
  systemPrompt?: string
  description?: string
  requirements?: string
  verifications?: string
  constraints?: string[]
}

/*
  Context-type PUT also replaces every field, so updates merge over the
  current record. Constraints are the API's enum; the web form's hint about
  "JSON objects" is wrong, the API wants the bare names.
*/
export function aiContextBody(current: Record<string, unknown> | undefined, input: AiContextInput): Record<string, unknown> {
  const base: Record<string, unknown> = current ? { ...current } : {}
  const body: Record<string, unknown> = {
    label: input.label ?? base["label"],
    context_type: input.contextType ?? base["context_type"],
    system_prompt: input.systemPrompt ?? base["system_prompt"],
    description: input.description ?? base["description"],
    requirements: input.requirements ?? base["requirements"],
    verifications: input.verifications ?? base["verifications"],
    constraints: input.constraints ?? base["constraints"] ?? [],
  }
  for (const key of ["label", "context_type", "system_prompt", "description"]) {
    if (typeof body[key] !== "string" || (body[key] as string).trim().length === 0) {
      throw new Error(`${key} is required`)
    }
  }
  if (!/^[a-z0-9_]+$/.test(String(body["context_type"]))) {
    throw new Error("context_type must be a slug of lowercase letters, digits and underscores")
  }
  const bad = (body["constraints"] as unknown[]).filter((c) => !AI_CONSTRAINTS.includes(c as AiConstraint))
  if (bad.length > 0) {
    throw new Error(`unknown constraints: ${bad.map(String).join(", ")} (valid: ${AI_CONSTRAINTS.join(", ")})`)
  }
  for (const key of ["requirements", "verifications"]) {
    if (body[key] === null || body[key] === undefined) delete body[key]
  }
  return body
}

export interface AiSessionFilters {
  escalated?: boolean
  complete?: boolean
  resolved?: boolean
  handled?: boolean
  contactId?: number
  unitId?: number
  since?: string
  until?: string
}

/*
  The session list API only honours filter[]; the flags the web app sends
  (is_escalate, date_start, ...) are ignored there. is_complete, is_escalate
  and is_resolved are timestamps, so a boolean becomes a null / notNull test.
*/
export function aiSessionFilters(opts: AiSessionFilters): string[] {
  const filters: string[] = []
  const flag = (column: string, value: boolean | undefined) => {
    if (value === undefined) return
    filters.push(`${column}:${value ? "notNull" : "null"}`)
  }
  flag("is_escalate", opts.escalated)
  flag("is_complete", opts.complete)
  flag("is_resolved", opts.resolved)
  flag("handled_at", opts.handled)
  if (opts.contactId !== undefined) filters.push(`contact_id:eq:${opts.contactId}`)
  if (opts.unitId !== undefined) filters.push(`unit_id:eq:${opts.unitId}`)
  if (opts.since) filters.push(`created_at:gte:${opts.since}`)
  if (opts.until) filters.push(`created_at:lte:${opts.until}`)
  return filters
}

export interface AiSessionStats {
  sessions: number
  escalated: number
  complete: number
  resolved: number
  handled: number
  turns: number
  errors: number
  spend_cents: number
  input_tokens: number
  output_tokens: number
  by_context: Record<string, number>
}

export function aiSessionStats(sessions: Array<Record<string, unknown>>): AiSessionStats {
  const stats: AiSessionStats = { sessions: 0, escalated: 0, complete: 0, resolved: 0, handled: 0, turns: 0, errors: 0, spend_cents: 0, input_tokens: 0, output_tokens: 0, by_context: {} }
  for (const s of sessions) {
    stats.sessions += 1
    if (s["is_escalate"]) stats.escalated += 1
    if (s["is_complete"]) stats.complete += 1
    if (s["is_resolved"]) stats.resolved += 1
    if (s["handled_at"]) stats.handled += 1
    stats.turns += Number(s["turns"] ?? 0)
    stats.errors += Number(s["errors"] ?? 0)
    stats.spend_cents += Number(s["spend"] ?? 0)
    stats.input_tokens += Number(s["input_tokens"] ?? 0)
    stats.output_tokens += Number(s["output_tokens"] ?? 0)
    const ctx = String(s["last_context_type"] ?? "unknown")
    stats.by_context[ctx] = (stats.by_context[ctx] ?? 0) + 1
  }
  return stats
}
