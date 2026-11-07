import type { Client } from "./request.js"

export const SCORING_CHANNELS = ["voice", "voicemail", "sms", "email", "airbnb", "whatsapp"] as const
export type ScoringChannel = (typeof SCORING_CHANNELS)[number]

export const SCORED_FILTERS = ["all", "scored", "unscored"] as const
export type ScoredFilter = (typeof SCORED_FILTERS)[number]

export const CRITERIA_SCORE_TYPES = ["scale", "boolean"] as const

export const CHANNEL_WEIGHTS: Record<ScoringChannel, number> = {
  voice: 1.5,
  voicemail: 1.5,
  sms: 1.0,
  email: 1.0,
  airbnb: 1.0,
  whatsapp: 1.0,
}

export function asScoringChannel(value: unknown, field = "channel"): ScoringChannel {
  if (typeof value === "string" && (SCORING_CHANNELS as readonly string[]).includes(value)) {
    return value as ScoringChannel
  }
  throw new Error(`${field} must be one of: ${SCORING_CHANNELS.join(", ")}`)
}

export function asScoredFilter(value: unknown, field = "scored"): ScoredFilter {
  if (typeof value === "string" && (SCORED_FILTERS as readonly string[]).includes(value)) {
    return value as ScoredFilter
  }
  throw new Error(`${field} must be one of: ${SCORED_FILTERS.join(", ")}`)
}

/*
  Wall-clock time in an IANA zone to a UTC instant, the same job the web app's
  zonedDate does with Temporal. Out-of-range parts roll over the way Date.UTC
  does (day 0 is the last day of the previous month). The offset is measured
  at the guessed instant and then re-measured once, which lands on the right
  side of a DST change.
*/
export function zonedDate(
  timeZone: string,
  year: number,
  monthIndex: number,
  day = 1,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): Date {
  const wall = Date.UTC(year, monthIndex, day, hour, minute, second, millisecond)
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value)
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
    return asUtc - Math.floor(instant / 1000) * 1000
  }
  const first = wall - offsetAt(wall)
  return new Date(wall - offsetAt(first))
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

export function zonedDayBounds(date: string, timeZone: string, edge: "start" | "end"): string {
  const match = DATE_ONLY.exec(date)
  if (!match) {
    if (Number.isNaN(Date.parse(date))) throw new Error(`${date} is not a date. Use YYYY-MM-DD or an ISO timestamp.`)
    return date
  }
  const [, y, m, d] = match
  const instant = edge === "start"
    ? zonedDate(timeZone, Number(y), Number(m) - 1, Number(d))
    : zonedDate(timeZone, Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999)
  return instant.toISOString()
}

export function monthRange(year: number, month: number, timeZone: string): [string, string] {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("month must be 1-12 and year a whole number")
  }
  return [
    zonedDate(timeZone, year, month - 1, 1).toISOString(),
    zonedDate(timeZone, year, month, 0, 23, 59, 59, 999).toISOString(),
  ]
}

export async function companyTimezone(api: Client, fallback: string): Promise<string> {
  const company = (await api.get<Record<string, unknown> | Array<Record<string, unknown>>>("/company"))
  const record = Array.isArray(company) ? company[0] : company
  const tz = record?.["timezone"]
  if (typeof tz !== "string" || tz.length === 0) return fallback
  const valid = await Promise.resolve()
    .then(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }))
    .then(() => true, () => false)
  return valid ? tz : fallback
}

export interface ConversationScoreFilters {
  agentId?: number
  brandId?: number
  contactId?: number
  channel?: ScoringChannel
  scored?: ScoredFilter
  dateStart?: string
  dateEnd?: string
  limit?: number
  offset?: number
}

export function conversationScoreQuery(filters: ConversationScoreFilters): Record<string, string | number | undefined> {
  return {
    limit: filters.limit ?? 100,
    offset: filters.offset,
    agentId: filters.agentId,
    brandId: filters.brandId,
    contactId: filters.contactId,
    channel: filters.channel,
    scored: filters.scored === "all" ? undefined : filters.scored,
    dateStart: filters.dateStart,
    dateEnd: filters.dateEnd,
  }
}

export function scoringCriteriaPath(opts: { channel?: ScoringChannel; templateId?: number; includeGlobal?: boolean }): {
  path: string
  query: Record<string, string | number | undefined>
} {
  if (opts.channel) {
    return { path: `/scoring-criteria/by-channel/${opts.channel}/`, query: { templateId: opts.templateId } }
  }
  if (opts.templateId !== undefined) {
    return {
      path: `/scoring-criteria/by-template/${opts.templateId}/`,
      query: { includeGlobal: opts.includeGlobal ? "true" : undefined },
    }
  }
  if (opts.includeGlobal) throw new Error("include_global only applies together with a template id")
  return { path: "/scoring-criteria", query: {} }
}

export interface ScoringCriterion {
  id: number
  name?: string
  weight?: number | string | null
  max_score?: number | string | null
  score_type?: string | null
}

export function criterionValue(criterion: ScoringCriterion, raw: unknown): number {
  const max = Number(criterion.max_score) || 100
  const label = criterion.name ? `${criterion.name} (#${criterion.id})` : `criterion ${criterion.id}`
  if (criterion.score_type === "boolean") {
    if (raw === true || raw === "true" || raw === "yes" || raw === 1 || raw === max) return max
    if (raw === false || raw === "false" || raw === "no" || raw === 0) return 0
    throw new Error(`${label} is pass/fail: give true/false (stored as ${max} or 0)`)
  }
  const value = typeof raw === "string" ? Number(raw) : raw
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${label} needs a score from 0 to ${max}`)
  }
  return value
}

export function messageScore(criteria: ScoringCriterion[], scores: Record<number, number>): number {
  let weightedSum = 0
  let totalWeight = 0
  for (const criterion of criteria) {
    const weight = Number(criterion.weight) || 1
    const maxScore = Number(criterion.max_score) || 100
    weightedSum += ((scores[criterion.id] ?? 0) / maxScore) * 100 * weight
    totalWeight += weight
  }
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0
}

export function overallScore(messages: Array<{ channel: ScoringChannel; score: number }>): number {
  let weighted = 0
  let total = 0
  for (const message of messages) {
    const weight = CHANNEL_WEIGHTS[message.channel] ?? 1
    weighted += message.score * weight
    total += weight
  }
  return total > 0 ? Math.round(weighted / total) : 0
}

export interface MessageScoreInput {
  channel: ScoringChannel
  related_id: number
  scoring_template_id?: number
  scores: Record<string, unknown>
}

export interface ScoredMessage {
  channel: ScoringChannel
  related_id: number
  scoring_template_id?: number
  criteria: ScoringCriterion[]
  scores: Record<number, number>
  score: number
}

export function scoreMessage(input: MessageScoreInput, criteria: ScoringCriterion[]): ScoredMessage {
  const where = `${input.channel} message ${input.related_id}`
  if (criteria.length === 0) {
    throw new Error(`No scoring criteria apply to ${where}${input.scoring_template_id ? ` with template ${input.scoring_template_id}` : ""}`)
  }
  const byId = new Map(criteria.map((c) => [Number(c.id), c]))
  const unknown = Object.keys(input.scores).filter((id) => !byId.has(Number(id)))
  if (unknown.length > 0) {
    throw new Error(`${where}: criteria ${unknown.join(", ")} do not apply. Applicable: ${criteria.map((c) => `${c.id}${c.name ? ` (${c.name})` : ""}`).join(", ")}`)
  }
  const missing = criteria.filter((c) => input.scores[String(c.id)] === undefined)
  if (missing.length > 0) {
    throw new Error(`${where}: missing scores for ${missing.map((c) => `${c.id}${c.name ? ` (${c.name})` : ""}`).join(", ")}`)
  }
  const scores: Record<number, number> = {}
  for (const criterion of criteria) {
    scores[criterion.id] = criterionValue(criterion, input.scores[String(criterion.id)])
  }
  return {
    channel: input.channel,
    related_id: input.related_id,
    scoring_template_id: input.scoring_template_id,
    criteria,
    scores,
    score: messageScore(criteria, scores),
  }
}

/*
  Mirrors the web app's saveAllScores payload. Each message contributes one
  rollup channel_score row (no criterion id, the message's weighted score)
  followed by one row per criterion. Those per-criterion rows are what let the
  web app reopen a score for editing with the original values. details holds
  each criterion's score averaged across the messages it was used on, and
  overall_score is the channel-weighted average of the message scores, with
  calls and voicemails counting 1.5x.
*/
export function conversationScorePayload(input: {
  conversationId: number
  agentId: number
  templateId?: number
  messages: ScoredMessage[]
}): Record<string, unknown> {
  if (input.messages.length === 0) throw new Error("Score at least one message")
  const channelScores: Array<Record<string, unknown>> = []
  const details = new Map<number, { total: number; count: number }>()
  for (const message of input.messages) {
    const templateId = message.scoring_template_id ?? input.templateId
    channelScores.push({
      channel: message.channel,
      related_id: message.related_id,
      score: message.score,
      scoring_template_id: templateId,
    })
    for (const criterion of message.criteria) {
      const value = message.scores[criterion.id] ?? 0
      channelScores.push({
        channel: message.channel,
        related_id: message.related_id,
        score: value,
        scoring_criteria_id: criterion.id,
        scoring_template_id: templateId,
      })
      const entry = details.get(criterion.id) ?? { total: 0, count: 0 }
      entry.total += value
      entry.count += 1
      details.set(criterion.id, entry)
    }
  }
  return {
    conversation_id: input.conversationId,
    agent_id: input.agentId,
    overall_score: overallScore(input.messages),
    scoring_template_id: input.templateId,
    details: [...details.entries()].map(([id, d]) => ({ scoring_criteria_id: id, score: Math.round(d.total / d.count) })),
    channel_scores: channelScores,
  }
}

export interface ScoreConversationInput {
  conversationId: number
  templateId?: number
  agentId?: number
  scoreId?: number
  messages: MessageScoreInput[]
}

export interface ScoreConversationResult {
  action: "created" | "updated"
  overall_score: number
  messages: Array<{ channel: ScoringChannel; related_id: number; score: number }>
  score: unknown
}

export async function scoreConversation(api: Client, input: ScoreConversationInput): Promise<ScoreConversationResult> {
  const conversation = await api.get<Record<string, unknown>>(`/conversation-scores/conversation/${input.conversationId}/for-scoring/`)
  const agent = conversation["agent"] as Record<string, unknown> | null | undefined
  const agentId = input.agentId ?? Number(agent?.["id"] ?? conversation["user_id"])
  if (!Number.isInteger(agentId) || agentId <= 0) {
    throw new Error(`Conversation ${input.conversationId} has no agent; pass the agent id to score it`)
  }

  const criteriaCache = new Map<string, Promise<ScoringCriterion[]>>()
  const criteriaFor = (channel: ScoringChannel, templateId: number | undefined): Promise<ScoringCriterion[]> => {
    const key = `${channel}:${templateId ?? ""}`
    let pending = criteriaCache.get(key)
    if (!pending) {
      const { path, query } = scoringCriteriaPath({ channel, templateId })
      pending = api.get<ScoringCriterion[]>(path, query).then((rows) => rows ?? [])
      criteriaCache.set(key, pending)
    }
    return pending
  }

  const scored: ScoredMessage[] = []
  for (const message of input.messages) {
    const channel = asScoringChannel(message.channel, `message ${message.related_id} channel`)
    const templateId = message.scoring_template_id ?? input.templateId
    const criteria = await criteriaFor(channel, templateId)
    scored.push(scoreMessage({ ...message, channel, scoring_template_id: templateId }, criteria))
  }

  const payload = conversationScorePayload({
    conversationId: input.conversationId,
    agentId,
    templateId: input.templateId,
    messages: scored,
  })
  const saved = input.scoreId !== undefined
    ? await api.put(`/conversation-scores/${input.scoreId}/`, payload)
    : await api.post("/conversation-scores", payload)
  return {
    action: input.scoreId !== undefined ? "updated" : "created",
    overall_score: payload["overall_score"] as number,
    messages: scored.map((m) => ({ channel: m.channel, related_id: m.related_id, score: m.score })),
    score: saved,
  }
}

export const KPI_GOAL_METRICS = [
  "conversion_percent",
  "lead_won_percent",
  "lead_revenue",
  "customer_service_time_percent",
  "queue_hangup_percent",
  "average_speed_to_answer_seconds",
  "average_handle_time_minutes",
  "conversation_scoring_average",
  "conversations_scored_count",
  "lost_opportunity",
  "first_response_time_minutes",
  "outbound_contacts_count",
  "task_completion_percent",
  "lead_follow_up_minutes",
  "max_lead_age_days",
] as const

export const KPI_GOAL_OPTIONAL_METRICS = ["nps_score_target", "survey_response_percent"] as const

export const KPI_AGENT_METRICS = ["conversion_percent", "lead_revenue"] as const

const ALL_KPI_METRICS: readonly string[] = [...KPI_GOAL_METRICS, ...KPI_GOAL_OPTIONAL_METRICS]

export type KpiMetricValues = Partial<Record<string, number | null>>

export function kpiMetricValues(input: Record<string, unknown>): KpiMetricValues {
  const values: KpiMetricValues = {}
  for (const [key, raw] of Object.entries(input)) {
    if (raw === undefined) continue
    if (!ALL_KPI_METRICS.includes(key)) {
      throw new Error(`Unknown KPI metric "${key}". Metrics: ${ALL_KPI_METRICS.join(", ")}`)
    }
    if (raw === null || raw === "") {
      if (!(KPI_GOAL_OPTIONAL_METRICS as readonly string[]).includes(key)) {
        throw new Error(`${key} cannot be cleared; only ${KPI_GOAL_OPTIONAL_METRICS.join(" and ")} are optional`)
      }
      values[key] = null
      continue
    }
    const n = typeof raw === "string" ? Number(raw) : raw
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${key} must be a number`)
    values[key] = n
  }
  return values
}

export interface KpiGoalScope {
  year: number
  month: number
  userId?: number | null
  brandId?: number | null
}

/*
  A new goal row starts the way the web app's form does: every required metric
  at 0 and the two optional targets null, then the caller's values on top.
  Updates send the whole row because PUT replaces it, so the existing goal is
  the base and only the metrics the caller named change.
*/
export function kpiGoalBody(scope: KpiGoalScope, values: KpiMetricValues, existing?: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const key of KPI_GOAL_METRICS) body[key] = existing?.[key] ?? 0
  for (const key of KPI_GOAL_OPTIONAL_METRICS) body[key] = existing?.[key] ?? null
  Object.assign(body, values)
  body["month"] = scope.month
  body["year"] = scope.year
  body["brand_id"] = scope.brandId ?? null
  if (scope.userId !== undefined && scope.userId !== null) body["user_id"] = scope.userId
  return body
}

export function kpiGoalScopeOf(goal: Record<string, unknown>): KpiGoalScope {
  return {
    year: Number(goal["year"]),
    month: Number(goal["month"]),
    userId: goal["user_id"] === null || goal["user_id"] === undefined ? null : Number(goal["user_id"]),
    brandId: goal["brand_id"] === null || goal["brand_id"] === undefined ? null : Number(goal["brand_id"]),
  }
}

export function agentKpiGoalBodies(scope: Omit<KpiGoalScope, "userId">, agentIds: number[], values: KpiMetricValues): Array<Record<string, unknown>> {
  const extra = Object.keys(values).filter((k) => !(KPI_AGENT_METRICS as readonly string[]).includes(k))
  if (extra.length > 0) {
    throw new Error(`Agent goals only carry ${KPI_AGENT_METRICS.join(" and ")}; ${extra.join(", ")} belong on the company goal`)
  }
  if (agentIds.length === 0) throw new Error("Give at least one agent id")
  return agentIds.map((userId) => kpiGoalBody({ ...scope, userId }, values))
}

export function findKpiGoal(goals: Array<Record<string, unknown>>, userId: number | null, brandId: number | null): Record<string, unknown> | undefined {
  return goals.find((g) => (g["user_id"] ?? null) === userId && (g["brand_id"] ?? null) === brandId)
}

export interface KpiReportInput {
  year: number
  month: number
  timeZone: string
  brandId?: number
  compare?: boolean
}

/*
  Mirrors the web app's KPI viewer: the selected month in full, then last
  month and the same month a year earlier with scalarsOnly so the API skips
  the per-agent breakdowns the comparison columns never read, and the goals
  set for that month.
*/
export async function runKpiReport(api: Client, input: KpiReportInput): Promise<Record<string, unknown>> {
  const run = (year: number, month: number, scalarsOnly: boolean) =>
    api.post<Record<string, unknown>>("/reports/run/kpi_report/0", {
      filterDates: monthRange(year, month, input.timeZone),
      brandId: input.brandId,
      scalarsOnly: scalarsOnly || undefined,
    })
  const last = new Date(Date.UTC(input.year, input.month - 2, 1))
  const [current, lastMonth, sameMonthLastYear, goals] = await Promise.all([
    run(input.year, input.month, false),
    input.compare === false ? Promise.resolve(undefined) : run(last.getUTCFullYear(), last.getUTCMonth() + 1, true),
    input.compare === false ? Promise.resolve(undefined) : run(input.year - 1, input.month, true),
    api.get<Array<Record<string, unknown>>>(`/kpi-goals/${input.year}/${input.month}/`, { brandId: input.brandId }),
  ])
  return {
    period: { year: input.year, month: input.month, timezone: input.timeZone, brand_id: input.brandId ?? null },
    current,
    last_month: lastMonth,
    same_month_last_year: sameMonthLastYear,
    goals,
  }
}

export interface ScoringTemplateInput {
  name?: string
  description?: string | null
  call_result_type_id?: number | null
  display_order?: number
}

/*
  PUT replaces the whole row, so an update starts from the stored template or
  criterion and only the fields the caller passed change.
*/
export function scoringTemplateBody(input: ScoringTemplateInput, existing?: Record<string, unknown>): Record<string, unknown> {
  const name = input.name ?? existing?.["name"]
  if (typeof name !== "string" || name.length === 0) throw new Error("name is required")
  return {
    name,
    description: input.description !== undefined ? input.description : existing?.["description"] ?? null,
    call_result_type_id: input.call_result_type_id !== undefined ? input.call_result_type_id : existing?.["call_result_type_id"] ?? null,
    display_order: input.display_order ?? Number(existing?.["display_order"] ?? 0),
  }
}

export interface ScoringCriterionInput {
  name?: string
  description?: string | null
  weight?: number
  max_score?: number
  display_order?: number
  channel?: ScoringChannel | null
  score_type?: string
  brand_ids?: number[]
  template_ids?: number[]
}

export function scoringCriterionBody(input: ScoringCriterionInput, existing?: Record<string, unknown>): Record<string, unknown> {
  const name = input.name ?? existing?.["name"]
  if (typeof name !== "string" || name.length === 0) throw new Error("name is required")
  const scoreType = input.score_type ?? existing?.["score_type"] ?? "scale"
  if (!(CRITERIA_SCORE_TYPES as readonly string[]).includes(String(scoreType))) {
    throw new Error(`score_type must be one of: ${CRITERIA_SCORE_TYPES.join(", ")}`)
  }
  const channel = input.channel !== undefined
    ? input.channel === null ? null : asScoringChannel(input.channel)
    : existing?.["channel"] ?? null
  const ids = (given: number[] | undefined, key: string): number[] | undefined => {
    if (given !== undefined) return given
    const current = existing?.[key]
    return Array.isArray(current) ? (current as unknown[]).map(Number) : undefined
  }
  const weight = input.weight ?? Number(existing?.["weight"] ?? 1)
  const maxScore = input.max_score ?? Number(existing?.["max_score"] ?? 10)
  if (!(weight > 0)) throw new Error("weight must be greater than 0")
  if (!(maxScore > 0)) throw new Error("max_score must be greater than 0")
  return {
    name,
    description: input.description !== undefined ? input.description : existing?.["description"] ?? null,
    weight,
    max_score: maxScore,
    display_order: input.display_order ?? Number(existing?.["display_order"] ?? 0),
    channel,
    score_type: scoreType,
    brand_ids: ids(input.brand_ids, "brand_ids"),
    template_ids: ids(input.template_ids, "template_ids"),
  }
}

export function displayOrders(ids: number[]): Array<{ id: number; display_order: number }> {
  if (ids.length === 0) throw new Error("Give the ids in the order they should appear")
  return ids.map((id, i) => ({ id, display_order: i + 1 }))
}
