import {
  SCORING_CHANNELS,
  SCORED_FILTERS,
  CRITERIA_SCORE_TYPES,
  KPI_GOAL_METRICS,
  KPI_GOAL_OPTIONAL_METRICS,
  KPI_AGENT_METRICS,
  agentKpiGoalBodies,
  asScoredFilter,
  asScoringChannel,
  companyTimezone,
  conversationScoreQuery,
  defaultTimezone,
  displayOrders,
  findKpiGoal,
  kpiGoalBody,
  kpiGoalScopeOf,
  kpiMetricValues,
  runKpiReport,
  scoreConversation,
  scoringCriteriaPath,
  scoringCriterionBody,
  scoringTemplateBody,
  zonedDayBounds,
  type MessageScoreInput,
  type ScoringChannel,
} from "@sendsquared/client"
import { apiForRequest, envelope, asNumber, asOptNumber, asOptString, asOptBoolean } from "./shared.js"
import type { ToolDefinition } from "./types.js"

function asId(v: unknown, field: string): number {
  const n = asNumber(v, field)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${field} must be a positive whole number`)
  return n
}

function asOptIdList(v: unknown, field: string): number[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v)) throw new Error(`${field} must be an array of ids`)
  return v.map((item, i) => asId(item, `${field}[${i}]`))
}

function asYearMonth(args: Record<string, unknown>): { year: number; month: number } {
  const year = asId(args["year"], "year")
  const month = asId(args["month"], "month")
  if (month > 12) throw new Error("month must be 1-12")
  return { year, month }
}

function nullableId(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  return asId(v, field)
}

const channelProp = { type: "string", enum: [...SCORING_CHANNELS] }
const idListProp = (description: string) => ({ type: "array", items: { type: "number" }, description })

const templateProps = {
  name: { type: "string" },
  description: { type: ["string", "null"] },
  call_result_type_id: { type: ["number", "null"], description: "Call result type that auto-selects this template when a call is given that result; null clears it" },
  display_order: { type: "number" },
}

const criterionProps = {
  name: { type: "string" },
  description: { type: ["string", "null"], description: "What the scorer looks for" },
  weight: { type: "number", description: "Relative weight in the message score (default 1)" },
  max_score: { type: "number", description: "Top of the scale (default 10). Pass/fail criteria store this or 0" },
  display_order: { type: "number" },
  channel: { type: ["string", "null"], enum: [...SCORING_CHANNELS, null], description: "Channel the criterion applies to; null means every channel" },
  score_type: { type: "string", enum: [...CRITERIA_SCORE_TYPES], description: "scale (0..max_score) or boolean (pass/fail)" },
  brand_ids: idListProp("Brands the criterion applies to; empty means every brand"),
  template_ids: idListProp("Scoring templates the criterion belongs to"),
}

function templateInputOf(args: Record<string, unknown>) {
  return {
    name: asOptString(args["name"]),
    description: args["description"] === null ? null : asOptString(args["description"]),
    call_result_type_id: nullableId(args["call_result_type_id"], "call_result_type_id"),
    display_order: asOptNumber(args["display_order"]),
  }
}

function criterionInputOf(args: Record<string, unknown>) {
  return {
    name: asOptString(args["name"]),
    description: args["description"] === null ? null : asOptString(args["description"]),
    weight: asOptNumber(args["weight"]),
    max_score: asOptNumber(args["max_score"]),
    display_order: asOptNumber(args["display_order"]),
    channel: args["channel"] === undefined ? undefined : args["channel"] === null ? null : asScoringChannel(args["channel"]),
    score_type: asOptString(args["score_type"]),
    brand_ids: asOptIdList(args["brand_ids"], "brand_ids"),
    template_ids: asOptIdList(args["template_ids"], "template_ids"),
  }
}

export const scoringTemplatesList: ToolDefinition = {
  name: "sendsquared_scoring_templates_list",
  description: "List scoring templates: named sets of criteria a conversation is graded against (Settings → Scoring). A template can be tied to a call result type so it is picked automatically.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get<unknown[]>("/scoring-templates")
    return envelope(data, `${(data ?? []).length} scoring templates`, ["sendsquared_scoring_criteria_list"])
  },
}

export const scoringTemplatesGet: ToolDefinition = {
  name: "sendsquared_scoring_templates_get",
  description: "Get one scoring template by id.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const data = await apiForRequest().get(`/scoring-templates/${id}/`)
    return envelope(data, `Scoring template ${id}`, ["sendsquared_scoring_criteria_list", "sendsquared_scoring_templates_criteria_set"])
  },
}

export const scoringTemplatesCreate: ToolDefinition = {
  name: "sendsquared_scoring_templates_create",
  description: "Create a scoring template. Criteria are attached afterwards with sendsquared_scoring_templates_criteria_set.",
  inputSchema: { type: "object", required: ["name"], properties: templateProps },
  handler: async (args) => {
    const data = await apiForRequest().post("/scoring-templates", scoringTemplateBody(templateInputOf(args)))
    return envelope(data, `Scoring template created: ${String(args["name"])}`, ["sendsquared_scoring_templates_criteria_set"])
  },
}

export const scoringTemplatesUpdate: ToolDefinition = {
  name: "sendsquared_scoring_templates_update",
  description: "Update a scoring template. Fields left out keep their stored value.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, ...templateProps } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const api = apiForRequest()
    const existing = await api.get<Record<string, unknown>>(`/scoring-templates/${id}/`)
    const data = await api.put(`/scoring-templates/${id}/`, scoringTemplateBody(templateInputOf(args), existing))
    return envelope(data, `Scoring template ${id} updated`)
  },
}

export const scoringTemplatesCriteriaSet: ToolDefinition = {
  name: "sendsquared_scoring_templates_criteria_set",
  description: "Replace the criteria attached to a scoring template. Criteria not in criteria_ids are detached from the template; an empty array detaches all.",
  inputSchema: {
    type: "object",
    required: ["id", "criteria_ids"],
    properties: { id: { type: "number" }, criteria_ids: idListProp("The template's full criteria list") },
  },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const criteriaIds = asOptIdList(args["criteria_ids"], "criteria_ids") ?? []
    const data = await apiForRequest().put(`/scoring-templates/${id}/criteria/`, { criteria_ids: criteriaIds })
    return envelope(data, `Template ${id} now has ${criteriaIds.length} criteria`, ["sendsquared_scoring_criteria_list"])
  },
}

export const scoringTemplatesReorder: ToolDefinition = {
  name: "sendsquared_scoring_templates_reorder",
  description: "Set the display order of scoring templates. ids are listed first to last and numbered from 1.",
  inputSchema: { type: "object", required: ["ids"], properties: { ids: idListProp("Template ids in display order") } },
  handler: async (args) => {
    const orders = displayOrders(asOptIdList(args["ids"], "ids") ?? [])
    await apiForRequest().put("/scoring-templates/reorder/", { orders })
    return envelope(orders, `Reordered ${orders.length} templates`)
  },
}

export const scoringTemplatesDelete: ToolDefinition = {
  name: "sendsquared_scoring_templates_delete",
  description: "Delete a scoring template.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const data = await apiForRequest().delete(`/scoring-templates/${id}/`)
    return envelope(data, `Scoring template ${id} deleted`)
  },
}

export const scoringCriteriaList: ToolDefinition = {
  name: "sendsquared_scoring_criteria_list",
  description:
    "List scoring criteria. With no filter: every criterion. With channel: the criteria a message on that channel is scored on (optionally within template_id) — the set the scoring screen shows. " +
    "With template_id alone: the template's criteria, plus criteria in no template when include_global is true.",
  inputSchema: {
    type: "object",
    properties: {
      channel: channelProp,
      template_id: { type: "number" },
      include_global: { type: "boolean" },
    },
  },
  handler: async (args) => {
    const { path, query } = scoringCriteriaPath({
      channel: args["channel"] === undefined ? undefined : asScoringChannel(args["channel"]),
      templateId: asOptNumber(args["template_id"]),
      includeGlobal: asOptBoolean(args["include_global"]),
    })
    const data = await apiForRequest().get<unknown[]>(path, query)
    return envelope(data, `${(data ?? []).length} scoring criteria`)
  },
}

export const scoringCriteriaGet: ToolDefinition = {
  name: "sendsquared_scoring_criteria_get",
  description: "Get one scoring criterion by id.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    return envelope(await apiForRequest().get(`/scoring-criteria/${id}/`), `Scoring criterion ${id}`)
  },
}

export const scoringCriteriaCreate: ToolDefinition = {
  name: "sendsquared_scoring_criteria_create",
  description: "Create a scoring criterion. A message's score is the weighted average of its criteria, each normalised to its max_score.",
  inputSchema: { type: "object", required: ["name"], properties: criterionProps },
  handler: async (args) => {
    const data = await apiForRequest().post("/scoring-criteria", scoringCriterionBody(criterionInputOf(args)))
    return envelope(data, `Scoring criterion created: ${String(args["name"])}`)
  },
}

export const scoringCriteriaUpdate: ToolDefinition = {
  name: "sendsquared_scoring_criteria_update",
  description: "Update a scoring criterion. Fields left out keep their stored value; brand_ids and template_ids replace the lists when given.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, ...criterionProps } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const api = apiForRequest()
    const existing = await api.get<Record<string, unknown>>(`/scoring-criteria/${id}/`)
    const data = await api.put(`/scoring-criteria/${id}/`, scoringCriterionBody(criterionInputOf(args), existing))
    return envelope(data, `Scoring criterion ${id} updated`)
  },
}

export const scoringCriteriaReorder: ToolDefinition = {
  name: "sendsquared_scoring_criteria_reorder",
  description: "Set the display order of scoring criteria. ids are listed first to last and numbered from 1.",
  inputSchema: { type: "object", required: ["ids"], properties: { ids: idListProp("Criterion ids in display order") } },
  handler: async (args) => {
    const orders = displayOrders(asOptIdList(args["ids"], "ids") ?? [])
    await apiForRequest().put("/scoring-criteria/reorder/", { orders })
    return envelope(orders, `Reordered ${orders.length} criteria`)
  },
}

export const scoringCriteriaDelete: ToolDefinition = {
  name: "sendsquared_scoring_criteria_delete",
  description: "Delete a scoring criterion.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    return envelope(await apiForRequest().delete(`/scoring-criteria/${id}/`), `Scoring criterion ${id} deleted`)
  },
}

export const conversationScoresList: ToolDefinition = {
  name: "sendsquared_conversation_scores_list",
  description:
    "Conversations available for call/conversation scoring (Call Center → Conversation Scoring), each with its contact, agent, call result and current score. " +
    "Dates are YYYY-MM-DD in the company timezone (date_to covers the whole day) or ISO timestamps.",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "number" },
      brand_id: { type: "number" },
      contact_id: { type: "number" },
      channel: { ...channelProp, description: "Only conversations that include this channel" },
      scored: { type: "string", enum: [...SCORED_FILTERS], default: "all" },
      date_from: { type: "string" },
      date_to: { type: "string" },
      limit: { type: "number", default: 100 },
      offset: { type: "number", default: 0 },
    },
  },
  handler: async (args) => {
    const api = apiForRequest()
    const from = asOptString(args["date_from"])
    const to = asOptString(args["date_to"])
    if ((from === undefined) !== (to === undefined)) throw new Error("date_from and date_to go together")
    const tz = from === undefined ? undefined : await companyTimezone(api, defaultTimezone())
    const query = conversationScoreQuery({
      agentId: asOptNumber(args["agent_id"]),
      brandId: asOptNumber(args["brand_id"]),
      contactId: asOptNumber(args["contact_id"]),
      channel: args["channel"] === undefined ? undefined : asScoringChannel(args["channel"]),
      scored: args["scored"] === undefined ? undefined : asScoredFilter(args["scored"]),
      dateStart: from && tz ? zonedDayBounds(from, tz, "start") : undefined,
      dateEnd: to && tz ? zonedDayBounds(to, tz, "end") : undefined,
      limit: asOptNumber(args["limit"]),
      offset: asOptNumber(args["offset"]),
    })
    const result = await api.list("/conversation-scores", query)
    return envelope({ conversations: result.data, total: result.total }, `${result.total} conversations`, [
      "sendsquared_conversation_scores_channels_get",
      "sendsquared_conversation_scores_create",
    ])
  },
}

export const conversationScoresConversationGet: ToolDefinition = {
  name: "sendsquared_conversation_scores_conversation_get",
  description: "One conversation as the scoring screen loads it: contact, agent, call result type and its current score summary.",
  inputSchema: { type: "object", required: ["conversation_id"], properties: { conversation_id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["conversation_id"], "conversation_id")
    const data = await apiForRequest().get(`/conversation-scores/conversation/${id}/for-scoring/`)
    return envelope(data, `Conversation ${id}`, ["sendsquared_conversation_scores_channels_get", "sendsquared_conversation_scores_for_conversation_list"])
  },
}

export const conversationScoresChannelsGet: ToolDefinition = {
  name: "sendsquared_conversation_scores_channels_get",
  description:
    "The scorable messages in a conversation grouped by channel. Each item's related_id is the timeline item id a message score refers to; " +
    "contact timeline tools show the content of those items.",
  inputSchema: { type: "object", required: ["conversation_id"], properties: { conversation_id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["conversation_id"], "conversation_id")
    const data = await apiForRequest().get(`/conversation-scores/conversation/${id}/channels/`)
    return envelope(data, `Channels in conversation ${id}`, ["sendsquared_scoring_criteria_list", "sendsquared_conversation_scores_create"])
  },
}

export const conversationScoresForConversationList: ToolDefinition = {
  name: "sendsquared_conversation_scores_for_conversation_list",
  description: "Scores recorded against one conversation.",
  inputSchema: { type: "object", required: ["conversation_id"], properties: { conversation_id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["conversation_id"], "conversation_id")
    const data = await apiForRequest().get<unknown[]>(`/conversation-scores/conversation/${id}/`)
    return envelope(data, `${(data ?? []).length} scores for conversation ${id}`, ["sendsquared_conversation_scores_get"])
  },
}

export const conversationScoresGet: ToolDefinition = {
  name: "sendsquared_conversation_scores_get",
  description: "Get a conversation score. with_channel_scores adds the per-message and per-criterion rows and whether the caller can edit it.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "number" }, with_channel_scores: { type: "boolean", default: false } },
  },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const path = asOptBoolean(args["with_channel_scores"]) ? `/conversation-scores/${id}/with-channel-scores/` : `/conversation-scores/${id}/`
    return envelope(await apiForRequest().get(path), `Conversation score ${id}`)
  },
}

const messagesProp = {
  type: "array",
  minItems: 1,
  description:
    "Scored messages. related_id comes from sendsquared_conversation_scores_channels_get; scores maps every applicable criterion id " +
    "(sendsquared_scoring_criteria_list with the message's channel and template) to a 0..max_score number, or true/false for pass/fail criteria.",
  items: {
    type: "object",
    required: ["channel", "related_id", "scores"],
    properties: {
      channel: channelProp,
      related_id: { type: "number" },
      scoring_template_id: { type: "number", description: "Template this message is graded against; defaults to the top-level template_id" },
      scores: { type: "object", additionalProperties: { type: ["number", "boolean"] } },
    },
  },
}

function messagesOf(v: unknown): MessageScoreInput[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error("messages must be a non-empty array")
  return v.map((raw, i) => {
    const m = raw as Record<string, unknown>
    const scores = m["scores"]
    if (!scores || typeof scores !== "object" || Array.isArray(scores)) throw new Error(`messages[${i}].scores must be an object`)
    return {
      channel: asScoringChannel(m["channel"], `messages[${i}].channel`) as ScoringChannel,
      related_id: asId(m["related_id"], `messages[${i}].related_id`),
      scoring_template_id: asOptNumber(m["scoring_template_id"]),
      scores: scores as Record<string, unknown>,
    }
  })
}

const scoreProps = {
  conversation_id: { type: "number" },
  messages: messagesProp,
  template_id: { type: "number", description: "Scoring template for messages that do not name one" },
  agent_id: { type: "number", description: "Agent being scored; defaults to the conversation's agent" },
}

export const conversationScoresCreate: ToolDefinition = {
  name: "sendsquared_conversation_scores_create",
  description:
    "Score a conversation the way the scoring screen does. Each message gets the weighted average of its criteria (each normalised to its max_score); " +
    "the overall score is the average of the message scores with calls and voicemails weighted 1.5x. Every criterion that applies to a message needs a score.",
  inputSchema: { type: "object", required: ["conversation_id", "messages"], properties: scoreProps },
  handler: async (args) => {
    const conversationId = asId(args["conversation_id"], "conversation_id")
    const result = await scoreConversation(apiForRequest(), {
      conversationId,
      templateId: asOptNumber(args["template_id"]),
      agentId: asOptNumber(args["agent_id"]),
      messages: messagesOf(args["messages"]),
    })
    return envelope(result, `Conversation ${conversationId} scored: overall ${result.overall_score}%`, ["sendsquared_conversation_scores_for_conversation_list"])
  },
}

export const conversationScoresUpdate: ToolDefinition = {
  name: "sendsquared_conversation_scores_update",
  description: "Re-score a conversation, replacing an existing score's messages, criteria rows and overall score. Same inputs and math as sendsquared_conversation_scores_create.",
  inputSchema: { type: "object", required: ["id", "conversation_id", "messages"], properties: { id: { type: "number", description: "Score id" }, ...scoreProps } },
  handler: async (args) => {
    const conversationId = asId(args["conversation_id"], "conversation_id")
    const result = await scoreConversation(apiForRequest(), {
      conversationId,
      scoreId: asId(args["id"], "id"),
      templateId: asOptNumber(args["template_id"]),
      agentId: asOptNumber(args["agent_id"]),
      messages: messagesOf(args["messages"]),
    })
    return envelope(result, `Conversation ${conversationId} re-scored: overall ${result.overall_score}%`)
  },
}

export const conversationScoresDelete: ToolDefinition = {
  name: "sendsquared_conversation_scores_delete",
  description: "Delete a conversation score.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    return envelope(await apiForRequest().delete(`/conversation-scores/${id}/`), `Conversation score ${id} deleted`)
  },
}

const ALL_KPI_METRICS = [...KPI_GOAL_METRICS, ...KPI_GOAL_OPTIONAL_METRICS]

const metricProps = (metrics: readonly string[]) =>
  Object.fromEntries(metrics.map((m) => [m, (KPI_GOAL_OPTIONAL_METRICS as readonly string[]).includes(m) ? { type: ["number", "null"] } : { type: "number" }]))

function metricArgs(args: Record<string, unknown>, metrics: readonly string[]) {
  return kpiMetricValues(Object.fromEntries(metrics.filter((m) => args[m] !== undefined).map((m) => [m, args[m]])))
}

const yearMonthProps = { year: { type: "number" }, month: { type: "number", description: "1-12" } }

export const kpiGoalsList: ToolDefinition = {
  name: "sendsquared_kpi_goals_list",
  description: "KPI goal rows for a month (Settings → Monthly & Agent Goals): the company row (user_id null) and per-agent rows. brand_id selects a brand's override set; omitted means All Brands.",
  inputSchema: { type: "object", required: ["year", "month"], properties: { ...yearMonthProps, brand_id: { type: "number" }, user_id: { type: "number", description: "Only this agent's row" } } },
  handler: async (args) => {
    const { year, month } = asYearMonth(args)
    const rows = (await apiForRequest().get<Array<Record<string, unknown>>>(`/kpi-goals/${year}/${month}/`, { brandId: asOptNumber(args["brand_id"]) })) ?? []
    const userId = asOptNumber(args["user_id"])
    const data = userId === undefined ? rows : rows.filter((g) => Number(g["user_id"]) === userId)
    return envelope(data, `${data.length} KPI goal rows for ${year}-${month}`, ["sendsquared_kpi_report", "sendsquared_kpi_goals_set"])
  },
}

export const kpiGoalsGet: ToolDefinition = {
  name: "sendsquared_kpi_goals_get",
  description: "Get one KPI goal row by id.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    return envelope(await apiForRequest().get(`/kpi-goals/${id}/`), `KPI goal ${id}`)
  },
}

export const kpiGoalsSet: ToolDefinition = {
  name: "sendsquared_kpi_goals_set",
  description:
    "Create or update a month's goals, like the goals screen's Save. Without user_id this is the company row and takes any metric; with user_id it is that agent's row, " +
    `which carries only ${KPI_AGENT_METRICS.join(" and ")}. Metrics left out keep their stored value (new rows start at 0, optional targets at null).`,
  inputSchema: {
    type: "object",
    required: ["year", "month"],
    properties: { ...yearMonthProps, brand_id: { type: "number", description: "Brand override set; omitted means All Brands" }, user_id: { type: "number" }, ...metricProps(ALL_KPI_METRICS) },
  },
  handler: async (args) => {
    const ym = asYearMonth(args)
    const brandId = asOptNumber(args["brand_id"]) ?? null
    const userId = asOptNumber(args["user_id"]) ?? null
    const values = metricArgs(args, ALL_KPI_METRICS)
    if (Object.keys(values).length === 0) throw new Error("Give at least one metric")
    if (userId !== null) agentKpiGoalBodies({ ...ym, brandId }, [userId], values)
    const api = apiForRequest()
    const rows = (await api.get<Array<Record<string, unknown>>>(`/kpi-goals/${ym.year}/${ym.month}/`, { brandId: brandId ?? undefined })) ?? []
    const existing = findKpiGoal(rows, userId, brandId)
    const body = kpiGoalBody({ ...ym, userId, brandId }, values, existing)
    const data = existing ? await api.put(`/kpi-goals/${String(existing["id"])}/`, body) : await api.post("/kpi-goals", body)
    return envelope(data, `${userId === null ? "Company" : `Agent ${userId}`} goals ${existing ? "updated" : "created"} for ${ym.year}-${ym.month}`)
  },
}

export const kpiGoalsUpdate: ToolDefinition = {
  name: "sendsquared_kpi_goals_update",
  description: "Change metrics on a KPI goal row by id. Metrics left out keep their stored value.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, ...metricProps(ALL_KPI_METRICS) } },
  handler: async (args) => {
    const id = asId(args["id"], "id")
    const values = metricArgs(args, ALL_KPI_METRICS)
    if (Object.keys(values).length === 0) throw new Error("Give at least one metric")
    const api = apiForRequest()
    const existing = await api.get<Record<string, unknown>>(`/kpi-goals/${id}/`)
    const data = await api.put(`/kpi-goals/${id}/`, kpiGoalBody(kpiGoalScopeOf(existing), values, existing))
    return envelope(data, `KPI goal ${id} updated`)
  },
}

export const kpiGoalsAgentsSave: ToolDefinition = {
  name: "sendsquared_kpi_goals_agents_save",
  description: `Save ${KPI_AGENT_METRICS.join(" and ")} goals for several agents in one call (the goals screen's Save All). Each listed agent's row for the month and brand is replaced.`,
  inputSchema: {
    type: "object",
    required: ["year", "month", "user_ids"],
    properties: { ...yearMonthProps, brand_id: { type: "number" }, user_ids: idListProp("Agent user ids"), ...metricProps(KPI_AGENT_METRICS) },
  },
  handler: async (args) => {
    const ym = asYearMonth(args)
    const bodies = agentKpiGoalBodies({ ...ym, brandId: asOptNumber(args["brand_id"]) ?? null }, asOptIdList(args["user_ids"], "user_ids") ?? [], metricArgs(args, KPI_AGENT_METRICS))
    const data = await apiForRequest().post("/kpi-goals/batch/", { goals: bodies })
    return envelope(data, `${bodies.length} agent goals saved for ${ym.year}-${ym.month}`, ["sendsquared_kpi_goals_list"])
  },
}

export const kpiReport: ToolDefinition = {
  name: "sendsquared_kpi_report",
  description:
    "The monthly KPI report as the web viewer shows it: the month's metrics with per-agent breakdowns, last month and the same month a year earlier for comparison, and the month's goals. " +
    "Month boundaries are in the company timezone. brand_id narrows the conversation-based metrics.",
  inputSchema: {
    type: "object",
    required: ["year", "month"],
    properties: { ...yearMonthProps, brand_id: { type: "number" }, timezone: { type: "string", description: "IANA timezone override" }, compare: { type: "boolean", default: true } },
  },
  handler: async (args) => {
    const ym = asYearMonth(args)
    const api = apiForRequest()
    const timeZone = asOptString(args["timezone"]) ?? await companyTimezone(api, defaultTimezone())
    const data = await runKpiReport(api, { ...ym, timeZone, brandId: asOptNumber(args["brand_id"]), compare: asOptBoolean(args["compare"]) })
    return envelope(data, `KPI report ${ym.year}-${ym.month}`, ["sendsquared_kpi_goals_list"])
  },
}

export const kpiDashboardStats: ToolDefinition = {
  name: "sendsquared_kpi_dashboard_stats",
  description: "The signed-in agent's own numbers for a month (conversion rate, leads, won leads, revenue), as on the agent dashboard.",
  inputSchema: { type: "object", required: ["year", "month"], properties: yearMonthProps },
  handler: async (args) => {
    const { year, month } = asYearMonth(args)
    return envelope(await apiForRequest().get(`/agents/dashboard-stats/${year}/${month}`), `Agent dashboard stats ${year}-${month}`)
  },
}

export const scoringTools: ToolDefinition[] = [
  scoringTemplatesList,
  scoringTemplatesGet,
  scoringTemplatesCreate,
  scoringTemplatesUpdate,
  scoringTemplatesCriteriaSet,
  scoringTemplatesReorder,
  scoringTemplatesDelete,
  scoringCriteriaList,
  scoringCriteriaGet,
  scoringCriteriaCreate,
  scoringCriteriaUpdate,
  scoringCriteriaReorder,
  scoringCriteriaDelete,
  conversationScoresList,
  conversationScoresConversationGet,
  conversationScoresChannelsGet,
  conversationScoresForConversationList,
  conversationScoresGet,
  conversationScoresCreate,
  conversationScoresUpdate,
  conversationScoresDelete,
]

export const kpiTools: ToolDefinition[] = [
  kpiGoalsList,
  kpiGoalsGet,
  kpiGoalsSet,
  kpiGoalsUpdate,
  kpiGoalsAgentsSave,
  kpiReport,
  kpiDashboardStats,
]
