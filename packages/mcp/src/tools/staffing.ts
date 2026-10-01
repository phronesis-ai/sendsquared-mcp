import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import { getRequestContext } from "../context.js"
import type { ToolDefinition } from "./types.js"

/*
  Staffing and agent productivity tools. These wrap the /v1/reports/run/*
  endpoints which accept POST with a body containing filterDates (start/end),
  timezone, companyId, and optional agent filters. The reportId path param is
  accepted by the API but not used in the handler — pass 0.

  companyId is extracted from the JWT payload and included in every report
  request because some report services read it from the params body rather
  than from the controller's async store context.

  All report endpoints return per-agent and/or time-series data. Revenue
  values are in CENTS — divide by 100 for dollars.
*/

function reportBody(args: Record<string, unknown>): Record<string, unknown> {
  const ctx = getRequestContext()
  const startDate = asString(args["start_date"], "start_date")
  const endDate = asString(args["end_date"], "end_date")
  const timezone = asOptString(args["timezone"]) ?? "America/Chicago"
  const body: Record<string, unknown> = {
    filterDates: [startDate, endDate],
    timezone,
    companyId: ctx.companyId,
  }
  const agentId = asOptNumber(args["agent_id"])
  if (agentId !== undefined) body["filterAgent"] = agentId
  if (agentId !== undefined) body["agentId"] = agentId
  return body
}

export const agentsList: ToolDefinition = {
  name: "sendsquared_agents_list",
  description: "List all agents (team members) for this company with their current status. Use this to discover agent IDs before running per-agent reports.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/user/agents")
    return envelope(data, "Agents", [
      "sendsquared_report_agent_productivity_live",
      "sendsquared_report_call_volume_by_agent",
    ])
  },
}

export const reportAgentProductivityLive: ToolDefinition = {
  name: "sendsquared_report_agent_productivity_live",
  description: "Real-time agent productivity — same as agent_productivity but reflects the current day's live data.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", description: "Start date YYYY-MM-DD" },
      end_date: { type: "string", description: "End date YYYY-MM-DD" },
      timezone: { type: "string", description: "Timezone (default: America/Chicago)" },
      agent_id: { type: "number", description: "Filter to a specific agent" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/agent_productivity_live/0", reportBody(args))
    return envelope(data, "Agent productivity (live)", [
      "sendsquared_report_agent_productivity_live",
    ])
  },
}

export const reportAgentBookedRevenue: ToolDefinition = {
  name: "sendsquared_report_agent_booked_revenue",
  description:
    "Revenue booked per agent — shows total booking revenue attributed to each agent over a date range. " +
    "Revenue values are in CENTS — divide by 100 for dollars.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string", description: "Start date YYYY-MM-DD" },
      end_date: { type: "string", description: "End date YYYY-MM-DD" },
      timezone: { type: "string", description: "Timezone (default: America/Chicago)" },
      agent_id: { type: "number", description: "Filter to a specific agent" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/agent_booked_rev/0", reportBody(args))
    return envelope(data, "Agent booked revenue (values in cents)", [
      "sendsquared_report_agent_productivity_live",
    ])
  },
}

export const reportCallVolumeStats: ToolDefinition = {
  name: "sendsquared_report_call_volume_stats",
  description:
    "Overall call volume statistics — total calls, inbound/outbound breakdown, queue calls, " +
    "voicemails, transfers, average answer time and handle time.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_volume_stats/0", reportBody(args))
    return envelope(data, "Call volume stats", [
      "sendsquared_report_call_volume_by_hour",
      "sendsquared_report_call_volume_by_day",
      "sendsquared_report_call_volume_by_agent",
    ])
  },
}

export const reportCallVolumeByDay: ToolDefinition = {
  name: "sendsquared_report_call_volume_by_day",
  description: "Call volume broken down by day. Shows daily trends — use this to identify which days of the week need more staffing.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_volume_by_day/0", reportBody(args))
    return envelope(data, "Call volume by day", [
      "sendsquared_report_call_volume_by_hour",
    ])
  },
}

export const reportCallVolumeByHour: ToolDefinition = {
  name: "sendsquared_report_call_volume_by_hour",
  description:
    "Call volume broken down by hour of day. The key staffing insight — shows peak hours when more agents are needed " +
    "and quiet hours where staff can be reduced. Use this for shift planning.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_volume_by_hour/0", reportBody(args))
    return envelope(data, "Call volume by hour (peak staffing data)", [
      "sendsquared_report_call_volume_by_day",
      "sendsquared_report_sms_volume_by_hour",
    ])
  },
}

export const reportCallVolumeByAgent: ToolDefinition = {
  name: "sendsquared_report_call_volume_by_agent",
  description:
    "Call volume per agent — total calls, inbound/outbound, answered, missed, queue calls, voicemails, " +
    "answer time, and handle time per agent. Shows who is handling the most calls and who is underperforming.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
      agent_id: { type: "number", description: "Filter to a specific agent" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_volume_by_agent/0", reportBody(args))
    return envelope(data, "Call volume by agent", [
      "sendsquared_report_agent_productivity_live",
      "sendsquared_report_call_abandonment_summary",
    ])
  },
}

export const reportCallStats: ToolDefinition = {
  name: "sendsquared_report_call_stats",
  description: "Call statistics — average call duration, missed call rate, queue wait times, service level metrics.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_stats/0", reportBody(args))
    return envelope(data, "Call statistics", [
      "sendsquared_report_call_volume_stats",
    ])
  },
}

export const reportCallAbandonmentSummary: ToolDefinition = {
  name: "sendsquared_report_call_abandonment_summary",
  description:
    "Call abandonment summary — shows how many callers hung up before being answered, broken down by day. " +
    "High abandonment = understaffed. Use alongside call_volume_by_hour to find when people are giving up.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_abandonment_summary/0", reportBody(args))
    return envelope(data, "Call abandonment summary", [
      "sendsquared_report_call_abandonment_detail",
      "sendsquared_report_call_volume_by_hour",
    ])
  },
}

export const reportCallAbandonmentDetail: ToolDefinition = {
  name: "sendsquared_report_call_abandonment_detail",
  description: "Call abandonment detail — individual abandoned calls with timestamps, wait durations, and caller info.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/call_abandonment_detail/0", reportBody(args))
    return envelope(data, "Call abandonment detail", [
      "sendsquared_report_call_abandonment_summary",
    ])
  },
}

export const reportSmsVolumeStats: ToolDefinition = {
  name: "sendsquared_report_sms_volume_stats",
  description:
    "SMS volume statistics — total messages, inbound/outbound breakdown, agent vs campaign messages, " +
    "segments used, and errors.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/sms_volume_stats/0", reportBody(args))
    return envelope(data, "SMS volume stats", [
      "sendsquared_report_sms_volume_by_hour",
      "sendsquared_report_sms_volume_by_day",
      "sendsquared_report_sms_volume_by_agent",
    ])
  },
}

export const reportSmsVolumeByDay: ToolDefinition = {
  name: "sendsquared_report_sms_volume_by_day",
  description: "SMS volume broken down by day. Shows daily message trends for staffing planning.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/sms_volume_stats_by_day/0", reportBody(args))
    return envelope(data, "SMS volume by day", [
      "sendsquared_report_sms_volume_by_hour",
    ])
  },
}

export const reportSmsVolumeByHour: ToolDefinition = {
  name: "sendsquared_report_sms_volume_by_hour",
  description:
    "SMS volume broken down by hour of day. Shows when text messages peak — " +
    "use this alongside call_volume_by_hour to determine total communication load per hour for staffing.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/sms_volume_stats_by_hour/0", reportBody(args))
    return envelope(data, "SMS volume by hour (peak staffing data)", [
      "sendsquared_report_call_volume_by_hour",
    ])
  },
}

export const reportSmsVolumeByAgent: ToolDefinition = {
  name: "sendsquared_report_sms_volume_by_agent",
  description: "SMS message volume per agent — shows who is handling the most text conversations.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/run/sms_volume_by_agent/0", reportBody(args))
    return envelope(data, "SMS volume by agent", [
      "sendsquared_report_sms_response_duration",
    ])
  },
}

export const reportSmsResponseDuration: ToolDefinition = {
  name: "sendsquared_report_sms_response_duration",
  description:
    "SMS response time per agent — average time to respond to inbound texts, both overall and during " +
    "business hours. Shows who responds fastest and who needs improvement. High response times = understaffed or undertrained.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
      business_hours_start: { type: "string", description: "Business hours start HH:MM (default 08:00)" },
      business_hours_end: { type: "string", description: "Business hours end HH:MM (default 18:00)" },
    },
  },
  handler: async (args) => {
    const body = reportBody(args)
    const start = asOptString(args["business_hours_start"]) ?? "08:00"
    const end = asOptString(args["business_hours_end"]) ?? "18:00"
    body["filterTime"] = [start, end]
    const data = await apiForRequest().post("/reports/run/sms_response_duration/0", body)
    return envelope(data, "SMS response duration by agent", [
      "sendsquared_report_email_response_duration",
      "sendsquared_report_sms_volume_by_agent",
    ])
  },
}

export const reportEmailResponseDuration: ToolDefinition = {
  name: "sendsquared_report_email_response_duration",
  description: "Email response time per agent — average time to respond to inbound emails, overall and during business hours.",
  inputSchema: {
    type: "object",
    required: ["start_date", "end_date"],
    properties: {
      start_date: { type: "string" },
      end_date: { type: "string" },
      timezone: { type: "string" },
      business_hours_start: { type: "string", description: "Business hours start HH:MM (default 08:00)" },
      business_hours_end: { type: "string", description: "Business hours end HH:MM (default 18:00)" },
    },
  },
  handler: async (args) => {
    const body = reportBody(args)
    const start = asOptString(args["business_hours_start"]) ?? "08:00"
    const end = asOptString(args["business_hours_end"]) ?? "18:00"
    body["filterTime"] = [start, end]
    const data = await apiForRequest().post("/reports/run/email_response_duration/0", body)
    return envelope(data, "Email response duration by agent", [
      "sendsquared_report_sms_response_duration",
    ])
  },
}

export const staffingTools: ToolDefinition[] = [
  agentsList,
  reportAgentProductivityLive,
  reportAgentBookedRevenue,
  reportCallVolumeStats,
  reportCallVolumeByDay,
  reportCallVolumeByHour,
  reportCallVolumeByAgent,
  reportCallStats,
  reportCallAbandonmentSummary,
  reportCallAbandonmentDetail,
  reportSmsVolumeStats,
  reportSmsVolumeByDay,
  reportSmsVolumeByHour,
  reportSmsVolumeByAgent,
  reportSmsResponseDuration,
  reportEmailResponseDuration,
]
