import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import {
  stepsToNestedTree,
  buildWorkflowActionNode,
  appendWorkflowAction,
  removeWorkflowAction,
  parseWorkflowDuration,
  WorkflowActionType,
  type WorkflowActionNode,
  type WorkflowStepDef,
} from "./transforms.js"
import type { ToolDefinition } from "./types.js"

/*
  Coerce a sync-interval / time-offset value to seconds. Accepts a raw number
  of seconds, a numeric string, or a duration string (30s, 5m, 2h, 1d, 1w).
*/
function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number") return v
  if (typeof v === "string" && v.length > 0) {
    if (/^\d+$/.test(v)) return Number(v)
    return parseWorkflowDuration(v)
  }
  return undefined
}

export const workflowsList: ToolDefinition = {
  name: "sendsquared_workflows_list",
  description: "List SendSquared automation workflows with pagination.",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number", default: 1 },
      limit: { type: "number", default: 25 },
    },
  },
  handler: async (args) => {
    const page = asOptNumber(args["page"]) ?? 1
    const limit = asOptNumber(args["limit"]) ?? 25
    const result = await apiForRequest().list("/workflows", { page, limit })
    return envelope(
      { workflows: result.data, total: result.total, page, limit },
      `${result.total} workflows found (page ${page})`,
      [
        "sendsquared_workflows_get",
        "sendsquared_workflows_create",
        "sendsquared_workflows_action_types",
        "sendsquared_workflows_trigger_types",
      ],
    )
  },
}

export const workflowsGet: ToolDefinition = {
  name: "sendsquared_workflows_get",
  description: "Fetch a single SendSquared workflow by id. The response includes the full nested action tree.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/workflows/${encodeURIComponent(id)}`)
    return envelope(data, `Workflow ${id}`, [
      "sendsquared_workflows_update",
      "sendsquared_workflows_add_step",
      "sendsquared_workflows_duplicate",
      "sendsquared_workflows_run_existing",
      "sendsquared_workflows_delete",
    ])
  },
}

export const workflowsCreate: ToolDefinition = {
  name: "sendsquared_workflows_create",
  description: "Create a SendSquared workflow with a trigger and an array of action steps. Steps are a flat array that gets converted into a nested action tree; use 'children' on a step to express branching. Time-based triggers (trigger_type time_based or gap_night) REQUIRE syncInterval — the API rejects them without it. Call sendsquared_workflows_step_format first if you need the step JSON schema.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      triggerType: {
        type: "string",
        description: "Trigger type, e.g. group, tag, time_based, gap_night, reservation, property",
      },
      triggerValue: {
        type: "string",
        description: "Trigger event, e.g. group.join, tag.join, arrival_date",
      },
      syncInterval: {
        type: "string",
        description: "REQUIRED for time-based triggers. How often the trigger re-evaluates — seconds (e.g. 86400) or a duration string (1d, 6h, 30m).",
      },
      timeOffset: {
        type: "string",
        description: "For time-based triggers: offset from the trigger event — seconds or a duration string (1d, 6h).",
      },
      steps: {
        type: "array",
        description: "Array of action steps. See sendsquared_workflows_step_format for the shape.",
        items: { type: "object" },
      },
      fromAddressId: { type: "number", description: "From-address id for email/sms steps" },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const body: Record<string, unknown> = {
      name,
      description: asOptString(args["description"]),
      active: false,
      flow_chart: {},
    }

    const triggerType = asOptString(args["triggerType"])
    if (triggerType) {
      const trigger: Record<string, unknown> = {
        trigger_type: triggerType,
        trigger_value: asOptString(args["triggerValue"]),
        conditions: [],
      }
      const syncInterval = toSeconds(args["syncInterval"])
      const timeOffset = toSeconds(args["timeOffset"])
      if (syncInterval !== undefined) trigger["sync_interval"] = syncInterval
      if (timeOffset !== undefined) trigger["time_offset"] = timeOffset
      body["trigger"] = trigger
    }

    const rawSteps = args["steps"]
    if (Array.isArray(rawSteps)) {
      body["action"] = stepsToNestedTree(
        rawSteps as WorkflowStepDef[],
        asOptNumber(args["fromAddressId"]),
      )
    }

    const data = await apiForRequest().post("/workflows", body)
    return envelope(data, `Workflow created: ${name}`, [
      "sendsquared_workflows_get",
      "sendsquared_workflows_add_step",
      "sendsquared_workflows_list",
    ])
  },
}

export const workflowsUpdate: ToolDefinition = {
  name: "sendsquared_workflows_update",
  description:
    "Update a SendSquared workflow's metadata, trigger, or action tree. Only fields you pass are " +
    "changed — the rest of the workflow (including the action tree and trigger settings) is preserved. " +
    "Passing 'steps' replaces the entire action tree. Trigger changes merge onto the existing trigger, " +
    "so you can add triggerConditions to a time-based workflow without re-supplying syncInterval.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      active: { type: "boolean", description: "Activate or deactivate the workflow" },
      triggerType: { type: "string" },
      triggerValue: { type: "string" },
      triggerConditions: { type: "array", items: { type: "object" } },
      syncInterval: { type: "string", description: "Time-based trigger re-evaluation interval — seconds or a duration string (1d, 6h)" },
      timeOffset: { type: "string", description: "Time-based trigger offset — seconds or a duration string (1d, 6h)" },
      steps: { type: "array", items: { type: "object" } },
      fromAddressId: { type: "number" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const client = apiForRequest()
    /*
      Fetch the current workflow and overlay the supplied fields. PUT replaces
      the whole record, so rebuilding it from scratch would drop the action
      tree and — critically for time-based triggers — sync_interval, which the
      validator then rejects. This mirrors how the web app saves automations.
    */
    const current = (await client.get(`/workflows/${encodeURIComponent(id)}`)) as Record<string, unknown>
    const body: Record<string, unknown> = { ...current }

    const name = asOptString(args["name"])
    const description = asOptString(args["description"])
    if (name) body["name"] = name
    if (description) body["description"] = description
    if (typeof args["active"] === "boolean") body["active"] = args["active"]

    const triggerType = asOptString(args["triggerType"])
    const triggerValue = asOptString(args["triggerValue"])
    const syncInterval = toSeconds(args["syncInterval"])
    const timeOffset = toSeconds(args["timeOffset"])
    const hasConditions = Array.isArray(args["triggerConditions"])
    if (triggerType || triggerValue || syncInterval !== undefined || timeOffset !== undefined || hasConditions) {
      const trigger: Record<string, unknown> = { ...((current["trigger"] as Record<string, unknown>) ?? {}) }
      if (triggerType) trigger["trigger_type"] = triggerType
      if (triggerValue) trigger["trigger_value"] = triggerValue
      if (syncInterval !== undefined) trigger["sync_interval"] = syncInterval
      if (timeOffset !== undefined) trigger["time_offset"] = timeOffset
      if (hasConditions) trigger["conditions"] = args["triggerConditions"]
      body["trigger"] = trigger
    }

    const rawSteps = args["steps"]
    if (Array.isArray(rawSteps)) {
      body["action"] = stepsToNestedTree(
        rawSteps as WorkflowStepDef[],
        asOptNumber(args["fromAddressId"]),
      )
    }

    const data = await client.put(`/workflows/${encodeURIComponent(id)}`, body)
    return envelope(data, `Workflow ${id} updated`, ["sendsquared_workflows_get"])
  },
}

export const workflowsAddStep: ToolDefinition = {
  name: "sendsquared_workflows_add_step",
  description: "Append a single action step to an existing workflow. For Wait steps, value is a duration string (30s, 5m, 2h, 1d, 1w); for all other types value is the template/action id.",
  inputSchema: {
    type: "object",
    required: ["workflowId", "type", "value"],
    properties: {
      workflowId: { type: "string" },
      type: {
        type: "string",
        enum: ["Email", "Sms", "Whatsapp", "PostCard", "Webhook", "Survey", "Wait", "Tag", "TagContact", "Task", "Airbnb"],
      },
      value: { type: "string", description: "Template/action id, or duration string for Wait" },
      label: { type: "string" },
      parentActionId: { type: "string", description: "Parent action id to nest under" },
      fromAddressId: { type: "number", description: "From-address id (Email/SMS steps)" },
      fromDisplayName: { type: "string", description: "Sender display name (Email steps)" },
      replyToAddress: { type: "string", description: "Reply-to email address (Email steps)" },
      replyToDisplayName: { type: "string", description: "Reply-to display name (Email steps)" },
      conditionType: { type: "string" },
      operator: { type: "string" },
      operand: { type: "string" },
      conditionValue: { type: "string" },
      conditionValueType: { type: "string" },
    },
  },
  handler: async (args) => {
    const workflowId = asString(args["workflowId"], "workflowId")
    const type = asString(args["type"], "type") as WorkflowActionType
    const rawValue = asString(args["value"], "value")
    const normalized = String(type).toLowerCase() as WorkflowActionType
    const isWait = normalized === WorkflowActionType.Wait
    const typeValue = isWait ? parseWorkflowDuration(rawValue) : Number(rawValue)

    const conditionType = asOptString(args["conditionType"])
    const condition = conditionType
      ? {
          type: conditionType,
          operator: asString(args["operator"], "operator"),
          operand: asString(args["operand"], "operand"),
          value: asString(args["conditionValue"], "conditionValue"),
          valueType: asOptString(args["conditionValueType"]) ?? "string",
        }
      : undefined

    const step = buildWorkflowActionNode(
      normalized,
      typeValue,
      asOptString(args["label"]),
      condition,
      asOptNumber(args["fromAddressId"]),
      {
        fromDisplayName: asOptString(args["fromDisplayName"]),
        replyToAddress: asOptString(args["replyToAddress"]),
        replyToDisplayName: asOptString(args["replyToDisplayName"]),
      },
    )
    const parentActionId = asOptString(args["parentActionId"])

    /*
      There is no per-action endpoint; the action tree is replaced atomically
      by PUT. Fetch the current record, graft the new step onto the tree, and
      write the whole workflow back — the same way the web app saves.
    */
    const client = apiForRequest()
    const current = (await client.get(`/workflows/${encodeURIComponent(workflowId)}`)) as Record<string, unknown>
    const body: Record<string, unknown> = { ...current }
    body["action"] = appendWorkflowAction(
      current["action"] as WorkflowActionNode | null | undefined,
      step,
      parentActionId ? Number(parentActionId) : undefined,
    )

    const data = await client.put(`/workflows/${encodeURIComponent(workflowId)}`, body)
    return envelope(data, `Step added to workflow ${workflowId}: ${type}`, [
      "sendsquared_workflows_get",
    ])
  },
}

export const workflowsRemoveStep: ToolDefinition = {
  name: "sendsquared_workflows_remove_step",
  description: "Remove an action step from a SendSquared workflow.",
  inputSchema: {
    type: "object",
    required: ["workflowId", "actionId"],
    properties: {
      workflowId: { type: "string" },
      actionId: { type: "string" },
    },
  },
  handler: async (args) => {
    const workflowId = asString(args["workflowId"], "workflowId")
    const actionId = asString(args["actionId"], "actionId")
    const client = apiForRequest()
    const current = (await client.get(`/workflows/${encodeURIComponent(workflowId)}`)) as Record<string, unknown>
    const root = current["action"] as WorkflowActionNode | null | undefined
    if (!root) throw new Error(`Workflow ${workflowId} has no steps`)
    const body: Record<string, unknown> = { ...current }
    body["action"] = removeWorkflowAction(root, Number(actionId))
    await client.put(`/workflows/${encodeURIComponent(workflowId)}`, body)
    return envelope(null, `Step ${actionId} removed from workflow ${workflowId}`, [
      "sendsquared_workflows_get",
    ])
  },
}

export const workflowsDuplicate: ToolDefinition = {
  name: "sendsquared_workflows_duplicate",
  description: "Duplicate a SendSquared workflow including its full action tree.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().post(`/workflows/${encodeURIComponent(id)}/duplicate`)
    return envelope(data, `Workflow ${id} duplicated`, ["sendsquared_workflows_list"])
  },
}

export const workflowsRunExisting: ToolDefinition = {
  name: "sendsquared_workflows_run_existing",
  description:
    "Run a workflow against contacts who are ALREADY in its trigger group or segment — i.e. process " +
    "historical members. High-impact and irreversible: it can fire emails/SMS to a large audience at " +
    "once. ALWAYS confirm with the user first, and DO NOT use it on survey-triggered workflows or any " +
    "workflow where re-processing historical members would re-send to people who already completed " +
    "the journey (e.g. every past survey respondent). Only use it right after activating a brand-new " +
    "workflow when the user explicitly wants existing members enrolled.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().put(`/workflows/${encodeURIComponent(id)}/future`)
    return envelope(data, `Workflow ${id} scheduled for existing members`, [
      "sendsquared_workflows_get",
    ])
  },
}

export const workflowsDelete: ToolDefinition = {
  name: "sendsquared_workflows_delete",
  description: "Delete a SendSquared workflow. Destructive — confirm with the user first.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/workflows/${encodeURIComponent(id)}`)
    return envelope(null, `Workflow ${id} deleted`, ["sendsquared_workflows_list"])
  },
}

export const workflowsActionTypes: ToolDefinition = {
  name: "sendsquared_workflows_action_types",
  description: "List the action types available for workflow steps (Email, Sms, Wait, etc.) and what their 'value' field means.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const types = Object.values(WorkflowActionType).map((t) => ({
      type: t,
      value_meaning: t === WorkflowActionType.Wait ? "Duration string (30s, 5m, 2h, 1d, 1w)" : "Template or resource id",
    }))
    return envelope(types, `${types.length} action types available`, [
      "sendsquared_workflows_trigger_types",
      "sendsquared_workflows_step_format",
    ])
  },
}

export const workflowsTriggerTypes: ToolDefinition = {
  name: "sendsquared_workflows_trigger_types",
  description:
    "List the trigger types and their valid trigger values for SendSquared workflows (group, tag, " +
    "time_based, gap_night, reservation, property, etc.), plus the conditions each trigger supports.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/triggers/config")
    return envelope(data, "Available trigger types and values", [
      "sendsquared_workflows_create",
      "sendsquared_workflows_step_format",
    ])
  },
}

const STEP_FORMAT_EXAMPLE = [
  { type: "Wait", value: "2d", label: "Wait 2 days after trigger" },
  { type: "Email", value: 42, label: "Send welcome email (template #42)" },
  {
    type: "Wait",
    value: "7d",
    label: "Wait 1 week",
    children: [
      {
        type: "Email",
        value: 55,
        label: "Follow-up email",
        condition: {
          type: "campaign",
          operator: "equal",
          operand: "opened",
          value: "false",
          valueType: "boolean",
        },
      },
    ],
  },
  {
    type: "Wait",
    value: "30d",
    label: "Wait 1 month",
    children: [
      { type: "Sms", value: 12, label: "Check-in SMS" },
      {
        type: "Wait",
        value: "60d",
        children: [{ type: "Email", value: 88, label: "Re-engagement email" }],
      },
    ],
  },
]

export const workflowsStepFormat: ToolDefinition = {
  name: "sendsquared_workflows_step_format",
  description: "Show the JSON format for workflow steps, including an example 6-month drip with branching and a conditional follow-up. Call this before building a workflow if you're unsure of the shape.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const help = {
      description: "JSON format for the steps argument when creating or updating workflows",
      action_types: "Email, Sms, Whatsapp, PostCard, Webhook, Survey, Wait, Tag, TagContact, Task, Airbnb",
      wait_durations: "30s (seconds), 5m (minutes), 2h (hours), 1d (days), 1w (weeks)",
      condition_types: "property, reservation, segment, sms, tag, lead, campaign, cart_abandon, contact_email, airbnb, survey",
      operators: "equal, notEqual, in, notIn, greater, greaterOrEqual, less, lessOrEqual, like, notLike, isNull, isNotNull",
      email_step_fields: "Email steps accept optional fromDisplayName, replyToAddress, replyToDisplayName on the step object — set them at create time, they cannot be added reliably afterward.",
      time_based_triggers: "time_based and gap_night triggers REQUIRE syncInterval on workflows_create/workflows_update (seconds or a duration string like 1d). Omitting it makes the API reject the workflow.",
      example_6_month_drip: STEP_FORMAT_EXAMPLE,
    }
    return envelope(help, "Workflow step format reference", [
      "sendsquared_workflows_action_types",
      "sendsquared_workflows_trigger_types",
      "sendsquared_workflows_create",
    ])
  },
}

export const workflowsTools: ToolDefinition[] = [
  workflowsList,
  workflowsGet,
  workflowsCreate,
  workflowsUpdate,
  workflowsAddStep,
  workflowsRemoveStep,
  workflowsDuplicate,
  workflowsRunExisting,
  workflowsDelete,
  workflowsActionTypes,
  workflowsTriggerTypes,
  workflowsStepFormat,
]
