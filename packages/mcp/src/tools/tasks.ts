import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const tasksList: ToolDefinition = {
  name: "sendsquared_tasks_list",
  description: "List SendSquared tasks with pagination and optional filtering. Tasks can be assigned to users and linked to contacts.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 25 },
      after_id: { type: "number", default: 0 },
      user_id: { type: "number", description: "Filter to tasks assigned to this user" },
      filter: {
        type: "array",
        items: { type: "string" },
        description: "Colon-delimited filter strings: 'field:operator:value'. E.g. ['contact_id:eq:42', 'priority:eq:1']. Operators: eq, ne, gt, gte, lt, lte, like, in, null, notNull.",
      },
      sort: {
        type: "array",
        items: { type: "string" },
        description: "Sort directives, e.g. ['due_date asc']",
      },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 25
    const after_id = asOptNumber(args["after_id"]) ?? 0
    const user_id = asOptNumber(args["user_id"])
    const filter = Array.isArray(args["filter"]) ? (args["filter"] as string[]) : undefined
    const sort = Array.isArray(args["sort"]) ? (args["sort"] as string[]) : undefined
    const query: Record<string, unknown> = { limit, after_id }
    if (user_id !== undefined) query["user_id"] = user_id
    if (filter) query["filter"] = filter
    if (sort) query["sort"] = sort

    const result = await apiForRequest().list("/tasks", query as Record<string, string | number | string[] | undefined>)
    return envelope(
      { tasks: result.data, total: result.total },
      `${result.total} tasks`,
      ["sendsquared_tasks_get", "sendsquared_tasks_create", "sendsquared_task_priorities"],
    )
  },
}

export const tasksGet: ToolDefinition = {
  name: "sendsquared_tasks_get",
  description: "Fetch a single SendSquared task by id, including its contact association and assigned users.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/tasks/${encodeURIComponent(id)}`)
    return envelope(data, `Task ${id}`, [
      "sendsquared_tasks_update",
      "sendsquared_tasks_complete",
      "sendsquared_tasks_assign",
    ])
  },
}

export const tasksCreate: ToolDefinition = {
  name: "sendsquared_tasks_create",
  description:
    "Create a new SendSquared task. Tasks can be assigned to team members, linked to a contact, " +
    "given a priority, due date, and reminder. sendsquared_task_types_list and sendsquared_task_priorities " +
    "return the valid type and priority values for this account.",
  inputSchema: {
    type: "object",
    required: ["label", "task_type_id"],
    properties: {
      label: { type: "string", description: "Task title (required)" },
      task_type_id: { type: "number", description: "Task type id (valid values come from sendsquared_task_types_list)" },
      description: { type: "string", description: "Detailed description or instructions" },
      priority: { type: "number", description: "Priority level (valid values come from sendsquared_task_priorities). Default: 0 (none)" },
      due_date: { type: "string", description: "Due date, ISO format YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss" },
      contact_id: { type: "number", description: "Link this task to a contact" },
      user_id: { type: "number", description: "Assign to a specific user (team member)" },
      users: { type: "array", items: { type: "number" }, description: "Array of user ids to add as followers" },
      remind_at: { type: "string", description: "Reminder datetime, ISO format" },
    },
  },
  handler: async (args) => {
    const label = asString(args["label"], "label")
    const task_type_id = asOptNumber(args["task_type_id"])
    if (task_type_id === undefined) throw new Error("task_type_id is required")
    const body: Record<string, unknown> = { label, task_type_id }
    const desc = asOptString(args["description"])
    const dueDate = asOptString(args["due_date"])
    const remindAt = asOptString(args["remind_at"])
    if (desc) body["description"] = desc
    if (args["priority"] !== undefined) body["priority"] = asOptNumber(args["priority"])
    if (dueDate) body["due_date"] = dueDate
    if (args["contact_id"] !== undefined) body["contact_id"] = asOptNumber(args["contact_id"])
    if (args["user_id"] !== undefined) body["user_id"] = asOptNumber(args["user_id"])
    if (Array.isArray(args["users"])) body["users"] = args["users"]
    if (remindAt) body["remind_at"] = remindAt

    const data = await apiForRequest().post("/tasks", body)
    return envelope(data, `Task created: ${label}`, [
      "sendsquared_tasks_get",
      "sendsquared_tasks_assign",
    ])
  },
}

export const tasksUpdate: ToolDefinition = {
  name: "sendsquared_tasks_update",
  description: "Update a SendSquared task's properties — label, description, priority, due date, contact link, etc.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      description: { type: "string" },
      priority: { type: "number" },
      due_date: { type: "string" },
      contact_id: { type: "number" },
      user_id: { type: "number" },
      users: { type: "array", items: { type: "number" } },
      remind_at: { type: "string" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = {}
    const label = asOptString(args["label"])
    const desc = asOptString(args["description"])
    const dueDate = asOptString(args["due_date"])
    const remindAt = asOptString(args["remind_at"])
    if (label) body["label"] = label
    if (desc) body["description"] = desc
    if (args["priority"] !== undefined) body["priority"] = asOptNumber(args["priority"])
    if (dueDate) body["due_date"] = dueDate
    if (args["contact_id"] !== undefined) body["contact_id"] = asOptNumber(args["contact_id"])
    if (args["user_id"] !== undefined) body["user_id"] = asOptNumber(args["user_id"])
    if (Array.isArray(args["users"])) body["users"] = args["users"]
    if (remindAt) body["remind_at"] = remindAt

    const data = await apiForRequest().put(`/tasks/${encodeURIComponent(id)}`, body)
    return envelope(data, `Task ${id} updated`, ["sendsquared_tasks_get"])
  },
}

export const tasksComplete: ToolDefinition = {
  name: "sendsquared_tasks_complete",
  description: "Mark a SendSquared task as completed.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().put(`/tasks/markcompleted/${encodeURIComponent(id)}`)
    return envelope(data, `Task ${id} marked complete`, ["sendsquared_tasks_list"])
  },
}

export const tasksAssign: ToolDefinition = {
  name: "sendsquared_tasks_assign",
  description: "Assign or unassign a SendSquared task to a user. Pass user_id to assign, or null to unassign.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      user_id: { type: "number", description: "User id to assign to, or null/0 to unassign" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const userId = asOptNumber(args["user_id"]) ?? null
    const data = await apiForRequest().put(`/tasks/assign/${encodeURIComponent(id)}`, { user_id: userId })
    return envelope(data, userId ? `Task ${id} assigned to user ${userId}` : `Task ${id} unassigned`, [
      "sendsquared_tasks_get",
    ])
  },
}

export const tasksDelete: ToolDefinition = {
  name: "sendsquared_tasks_delete",
  description: "Delete a SendSquared task. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/tasks/${encodeURIComponent(id)}`)
    return envelope(null, `Task ${id} deleted`, ["sendsquared_tasks_list"])
  },
}

export const taskPriorities: ToolDefinition = {
  name: "sendsquared_task_priorities",
  description: "List the task priority levels configured for this company. Call before creating tasks to discover valid priority values.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/tasks/task-priorities")
    return envelope(data, "Task priorities", ["sendsquared_tasks_create"])
  },
}

export const tasksTools: ToolDefinition[] = [
  tasksList,
  tasksGet,
  tasksCreate,
  tasksUpdate,
  tasksComplete,
  tasksAssign,
  tasksDelete,
  taskPriorities,
]
