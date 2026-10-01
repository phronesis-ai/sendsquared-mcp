import { apiForRequest, envelope, asString, asOptString, asOptNumber, asNumber } from "./shared.js"
import { parseConditions, type ConditionBlockDef } from "./transforms.js"
import type { ToolDefinition } from "./types.js"

interface GroupRecord {
  id?: number
  [key: string]: unknown
}

/*
  Group folders are a join table (group_folders), not a column on the group,
  so the API has no folder field on create. Filing happens as a second call
  after the group exists.
*/
async function fileUnderFolder(group: GroupRecord, folderId?: number): Promise<void> {
  if (folderId === undefined || group.id === undefined) return
  await apiForRequest().put(`/groups/${group.id}/folder/${folderId}`)
}

function groupIdsFromArgs(args: Record<string, unknown>): string[] {
  const single = asOptString(args["id"])
  const batch = Array.isArray(args["ids"]) ? (args["ids"] as unknown[]).map(String) : []
  const ids = single ? [single, ...batch] : batch
  if (ids.length === 0) throw new Error("Pass id or a non-empty ids array")
  return ids
}

async function moveGroups(
  groupIds: string[],
  request: (groupId: string) => Promise<unknown>,
): Promise<{ done: string[]; failed: Array<{ id: string; error: string }> }> {
  const done: string[] = []
  const failed: Array<{ id: string; error: string }> = []
  for (const id of groupIds) {
    const error = await request(id).then(
      () => undefined,
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    )
    if (error === undefined) done.push(id)
    else failed.push({ id, error })
  }
  return { done, failed }
}

export const groupsList: ToolDefinition = {
  name: "sendsquared_groups_list",
  description: "List SendSquared groups and segments. Optionally filter by type (standard manual groups vs. dynamic segments).",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["standard", "segment"],
        description: "Filter to only standard groups or only segments",
      },
      folder_id: {
        type: "number",
        description: "Only groups filed under this group folder (see sendsquared_folders_list with folder_type 'group'). 0 returns unfiled groups.",
      },
    },
  },
  handler: async (args) => {
    const type = asOptString(args["type"])
    const folderId = asOptNumber(args["folder_id"])
    const result = await apiForRequest().list("/groups", { group_type: type, folder: folderId })
    return envelope(
      { groups: result.data, total: result.total },
      `${result.total} groups`,
      [
        "sendsquared_groups_get",
        "sendsquared_groups_create",
        "sendsquared_groups_create_segment",
        "sendsquared_groups_set_folder",
        "sendsquared_contacts_list",
      ],
    )
  },
}

export const groupsGet: ToolDefinition = {
  name: "sendsquared_groups_get",
  description: "Fetch a single SendSquared group or segment by id. For segments the response includes the full condition tree.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/groups/${encodeURIComponent(id)}`)
    return envelope(data, `Group ${id}`, [
      "sendsquared_contacts_list",
      "sendsquared_groups_update",
      "sendsquared_groups_update_conditions",
      "sendsquared_groups_duplicate",
      "sendsquared_groups_delete",
    ])
  },
}

export const groupsCreate: ToolDefinition = {
  name: "sendsquared_groups_create",
  description: "Create a standard (manual) SendSquared group. Contacts are added to manual groups one at a time via sendsquared_groups_add_contact.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", description: "Group name" } },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const data = await apiForRequest().post("/groups", {
      name,
      group_type: "standard",
    })
    return envelope(data, `Group created: ${name}`, [
      "sendsquared_groups_add_contact",
      "sendsquared_groups_list",
    ])
  },
}

export const groupsCreateSegment: ToolDefinition = {
  name: "sendsquared_groups_create_segment",
  description: "Create a dynamic SendSquared segment. Conditions are expressed as an array of blocks where conditions inside a block share the block's logic (and/or) and blocks are ANDed together. Use sendsquared_groups_condition_format for the full format reference.",
  inputSchema: {
    type: "object",
    required: ["name", "conditions"],
    properties: {
      name: { type: "string", description: "Segment name" },
      conditions: {
        type: "array",
        description: "Array of condition blocks. See sendsquared_groups_condition_format.",
        items: { type: "object" },
      },
      folder_id: { type: "number", description: "Group folder to file the new segment under" },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const folderId = asOptNumber(args["folder_id"])
    const rawConditions = args["conditions"]
    if (!Array.isArray(rawConditions)) {
      throw new Error("conditions must be an array of condition blocks")
    }
    const conditions = parseConditions(rawConditions as ConditionBlockDef[])
    const data = (await apiForRequest().post("/groups", {
      name,
      group_type: "segment",
      conditions,
    })) as GroupRecord
    await fileUnderFolder(data, folderId)
    return envelope(data, `Segment created: ${name}`, [
      "sendsquared_groups_get",
      "sendsquared_contacts_list",
      "sendsquared_workflows_create",
    ])
  },
}

export const groupsUpdate: ToolDefinition = {
  name: "sendsquared_groups_update",
  description: "Rename a SendSquared group or segment.",
  inputSchema: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const name = asString(args["name"], "name")
    const data = await apiForRequest().put(`/groups/${encodeURIComponent(id)}`, { name })
    return envelope(data, `Group ${id} updated`, ["sendsquared_groups_get"])
  },
}

export const groupsUpdateConditions: ToolDefinition = {
  name: "sendsquared_groups_update_conditions",
  description:
    "Replace the condition tree on a SendSquared segment. Conditions format matches sendsquared_groups_create_segment. " +
    "The underlying PUT silently no-ops if `name` is not included in the payload — this tool fetches the current " +
    "name and includes it automatically, so callers don't need to.",
  inputSchema: {
    type: "object",
    required: ["id", "conditions"],
    properties: {
      id: { type: "string" },
      conditions: {
        type: "array",
        description: "Array of condition blocks. See sendsquared_groups_condition_format.",
        items: { type: "object" },
      },
      name: {
        type: "string",
        description: "Optional new segment name. If omitted, the current name is fetched and preserved.",
      },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const rawConditions = args["conditions"]
    if (!Array.isArray(rawConditions)) {
      throw new Error("conditions must be an array of condition blocks")
    }
    const conditions = parseConditions(rawConditions as ConditionBlockDef[])
    const api = apiForRequest()
    let name = asOptString(args["name"])
    if (!name) {
      const current = await api.get<{ name?: string }>(`/groups/${encodeURIComponent(id)}`)
      name = asOptString(current.name)
      if (!name) {
        throw new Error(`Group ${id} has no name to preserve — pass a name argument explicitly`)
      }
    }
    const data = await api.put(`/groups/${encodeURIComponent(id)}`, { name, conditions })
    return envelope(data, `Segment ${id} conditions updated`, [
      "sendsquared_groups_get",
      "sendsquared_contacts_list",
    ])
  },
}

export const groupsDuplicate: ToolDefinition = {
  name: "sendsquared_groups_duplicate",
  description: "Duplicate a SendSquared group or segment.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().post(`/groups/duplicate/${encodeURIComponent(id)}`)
    return envelope(data, `Group ${id} duplicated`, ["sendsquared_groups_list"])
  },
}

export const groupsDelete: ToolDefinition = {
  name: "sendsquared_groups_delete",
  description: "Delete a SendSquared group or segment. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/groups/${encodeURIComponent(id)}`)
    return envelope(null, `Group ${id} deleted`, ["sendsquared_groups_list"])
  },
}

export const groupsAddContact: ToolDefinition = {
  name: "sendsquared_groups_add_contact",
  description: "Add a contact to a standard (manual) SendSquared group. Segments are dynamic and cannot have contacts added directly.",
  inputSchema: {
    type: "object",
    required: ["groupId", "contactId"],
    properties: {
      groupId: { type: "string" },
      contactId: { type: "string" },
    },
  },
  handler: async (args) => {
    const groupId = asString(args["groupId"], "groupId")
    const contactId = asString(args["contactId"], "contactId")
    await apiForRequest().post("/group-contacts", { groupId, contactId })
    return envelope(
      null,
      `Contact ${contactId} added to group ${groupId}`,
      ["sendsquared_contacts_list"],
    )
  },
}

export const groupsRemoveContact: ToolDefinition = {
  name: "sendsquared_groups_remove_contact",
  description: "Remove a contact from a standard SendSquared group.",
  inputSchema: {
    type: "object",
    required: ["groupId", "contactId"],
    properties: {
      groupId: { type: "string" },
      contactId: { type: "string" },
    },
  },
  handler: async (args) => {
    const groupId = asString(args["groupId"], "groupId")
    const contactId = asString(args["contactId"], "contactId")
    await apiForRequest().delete(`/group-contacts/${encodeURIComponent(groupId)}/${encodeURIComponent(contactId)}`)
    return envelope(
      null,
      `Contact ${contactId} removed from group ${groupId}`,
      ["sendsquared_contacts_list"],
    )
  },
}

export const groupsSetFolder: ToolDefinition = {
  name: "sendsquared_groups_set_folder",
  description:
    "File one or more groups/segments under a group folder. A group may live in several folders at once, so this adds a folder rather than moving; pair with sendsquared_groups_unset_folder to move. Use sendsquared_folders_list with folder_type 'group' to find or sendsquared_folders_create to make the destination.",
  inputSchema: {
    type: "object",
    required: ["folder_id"],
    properties: {
      id: { type: "string", description: "Group id (single)" },
      ids: { type: "array", items: { type: "string" }, description: "Group ids (batch)" },
      folder_id: { type: "number", description: "Destination group folder id" },
    },
  },
  handler: async (args) => {
    const folderId = asNumber(args["folder_id"], "folder_id")
    const ids = groupIdsFromArgs(args)
    const result = await moveGroups(ids, (id) => apiForRequest().put(`/groups/${encodeURIComponent(id)}/folder/${folderId}`))
    return envelope(
      { folder_id: folderId, filed: result.done, failed: result.failed },
      `${result.done.length} filed under folder ${folderId}, ${result.failed.length} failed`,
      ["sendsquared_groups_list", "sendsquared_groups_unset_folder"],
    )
  },
}

export const groupsUnsetFolder: ToolDefinition = {
  name: "sendsquared_groups_unset_folder",
  description: "Remove one or more groups/segments from a group folder. The groups themselves are kept.",
  inputSchema: {
    type: "object",
    required: ["folder_id"],
    properties: {
      id: { type: "string", description: "Group id (single)" },
      ids: { type: "array", items: { type: "string" }, description: "Group ids (batch)" },
      folder_id: { type: "number", description: "Group folder id" },
    },
  },
  handler: async (args) => {
    const folderId = asNumber(args["folder_id"], "folder_id")
    const ids = groupIdsFromArgs(args)
    const result = await moveGroups(ids, (id) => apiForRequest().delete(`/groups/${encodeURIComponent(id)}/folder/${folderId}`))
    return envelope(
      { folder_id: folderId, removed: result.done, failed: result.failed },
      `${result.done.length} removed from folder ${folderId}, ${result.failed.length} failed`,
      ["sendsquared_groups_list"],
    )
  },
}

export const groupsConditionConfig: ToolDefinition = {
  name: "sendsquared_groups_condition_config",
  description: "List the available condition types, operators, and value types for SendSquared segments. Shows what the account supports for building conditions.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/groups/condition-config/")
    return envelope(data, "Segment condition configuration", [
      "sendsquared_groups_create_segment",
      "sendsquared_groups_condition_format",
    ])
  },
}

const CONDITION_FORMAT_EXAMPLE = [
  {
    block: 1,
    logic: "and",
    conditions: [
      { type: "property", field: "contacts.state", op: "equal", value: "CA", valueType: "string" },
      { type: "tag", field: "tag_id", op: "equal", value: "5", valueType: "integer" },
    ],
  },
  {
    block: 2,
    logic: "or",
    conditions: [
      { type: "property", field: "contacts.email", op: "like", value: "%@gmail.com", valueType: "string" },
      { type: "reservation", field: "check_in", op: "greater", value: "2026-01-01", valueType: "datetime" },
    ],
  },
]

export const groupsConditionFormat: ToolDefinition = {
  name: "sendsquared_groups_condition_format",
  description: "Show the JSON format for segment conditions, including an example that combines multiple blocks and condition types. Reference for the shape of segment conditions.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const help = {
      description: "JSON format for the conditions argument when creating or updating segments",
      logic: "Conditions in a block use the block's logic (and/or). Blocks are combined with AND.",
      example_meaning: "(state = CA AND has tag #5) AND (email contains @gmail.com OR check-in after 2026-01-01)",
      condition_types: "property, reservation, segment, sms, sms_opt, tag, lead, campaign, cart_abandon, contact_email, contact_unit_week, airbnb, survey",
      operators: "equal, notEqual, in, notIn, greater, greaterOrEqual, less, lessOrEqual, like, notLike, isNull, isNotNull",
      value_types: "string, integer, number, datetime, datetimeRelative, datetimeMonth, time, date, dateRange, boolean, null",
      example: CONDITION_FORMAT_EXAMPLE,
    }
    return envelope(help, "Segment condition format reference", [
      "sendsquared_groups_condition_config",
      "sendsquared_groups_create_segment",
    ])
  },
}

export const groupsTools: ToolDefinition[] = [
  groupsList,
  groupsGet,
  groupsCreate,
  groupsCreateSegment,
  groupsUpdate,
  groupsUpdateConditions,
  groupsDuplicate,
  groupsDelete,
  groupsAddContact,
  groupsRemoveContact,
  groupsSetFolder,
  groupsUnsetFolder,
  groupsConditionConfig,
  groupsConditionFormat,
]
