export interface ConditionDef {
  type: string
  field: string
  op: string
  value: string
  valueType?: string
}

export interface ConditionBlockDef {
  block: number
  logic?: "and" | "or"
  conditions: ConditionDef[]
}

export interface ConditionInput {
  condition_block: number
  condition_type: string
  operand: string
  operator: string
  value: string
  value_type: string
  logic_type: "and" | "or"
}

/*
  Flattens a block-structured condition definition into the flat shape the
  SendSquared API expects. Blocks group conditions that share the same logic
  (and/or); across blocks the API ANDs the block-level results together.
  This mirrors packages/cli/src/commands/groups.ts so segments built via the
  MCP server produce identical API bodies to those built via the CLI.
*/
export function parseConditions(blocks: ConditionBlockDef[]): ConditionInput[] {
  const out: ConditionInput[] = []
  for (const block of blocks) {
    for (const cond of block.conditions) {
      out.push({
        condition_block: block.block,
        condition_type: cond.type,
        operand: cond.field,
        operator: cond.op,
        value: cond.value,
        value_type: cond.valueType ?? "string",
        logic_type: block.logic ?? "and",
      })
    }
  }
  return out
}

export enum WorkflowActionType {
  Email = "email",
  Sms = "sms",
  Whatsapp = "whatsapp",
  PostCard = "postcard",
  Webhook = "webhook",
  Survey = "survey",
  Wait = "wait",
  Tag = "tag",
  TagContact = "tag_contact",
  Task = "task",
  Airbnb = "airbnb",
}

export type WorkflowActionInput = {
  label?: string
  action_id?: number
  action_type: WorkflowActionType
  type_value: number
  from_address_id?: number | null
  from_display_name?: string | null
  reply_to_address?: string | null
  reply_to_display_name?: string | null
  send_to?: string[]
  entity_attribute?: null
  condition_type?: string | null
  operator?: string | null
  operand?: string | null
  value?: string | null
  value_type?: string | null
  children: WorkflowActionInput[]
}

export interface WorkflowEmailOptions {
  fromDisplayName?: string
  replyToAddress?: string
  replyToDisplayName?: string
}

export function parseWorkflowDuration(dur: string): number {
  const match = dur.match(/^(\d+)(s|m|h|d|w)$/)
  if (!match) throw new Error(`Invalid duration "${dur}". Use format: 30s, 5m, 2h, 1d, 1w`)
  const num = parseInt(match[1]!, 10)
  switch (match[2]) {
    case "s": return num
    case "m": return num * 60
    case "h": return num * 3600
    case "d": return num * 86400
    case "w": return num * 604800
    default: return num
  }
}

export interface WorkflowStepDef {
  type: string
  value: string | number
  label?: string
  condition?: { type: string; operator: string; operand: string; value: string; valueType: string }
  children?: WorkflowStepDef[]
  fromDisplayName?: string
  replyToAddress?: string
  replyToDisplayName?: string
}

export function buildWorkflowActionNode(
  type: WorkflowActionType,
  typeValue: number,
  label?: string,
  condition?: { type: string; operator: string; operand: string; value: string; valueType: string },
  fromAddressId?: number,
  email?: WorkflowEmailOptions,
): WorkflowActionInput {
  const needsFrom = [WorkflowActionType.Email, WorkflowActionType.Sms, WorkflowActionType.Whatsapp].includes(type)
  const isWait = type === WorkflowActionType.Wait
  const node: WorkflowActionInput = {
    label,
    action_type: type,
    type_value: typeValue,
    condition_type: condition?.type ?? null,
    operator: condition?.operator ?? null,
    operand: condition?.operand ?? null,
    value: condition?.value ?? null,
    value_type: condition?.valueType ?? null,
    children: [],
  }
  if (needsFrom) {
    node.from_address_id = fromAddressId ?? null
    node.send_to = ["contact"]
  }
  if (isWait) {
    node.entity_attribute = null
  }
  /*
    Email steps carry an optional sender/reply-to identity. The API accepts
    these fields on the action node but stores null unless they are sent, so
    we only attach them when supplied.
  */
  if (type === WorkflowActionType.Email && email) {
    if (email.fromDisplayName !== undefined) node.from_display_name = email.fromDisplayName
    if (email.replyToAddress !== undefined) node.reply_to_address = email.replyToAddress
    if (email.replyToDisplayName !== undefined) node.reply_to_display_name = email.replyToDisplayName
  }
  return node
}

/*
  Converts a flat array of workflow step definitions into the deeply nested
  action tree the SendSquared API expects. Each step becomes the sole child of
  the previous step, creating a single spine. Branching is expressed through
  explicit "children" arrays inside step definitions — we recurse into them.
  Matches the logic in packages/cli/src/commands/workflows.ts.
*/
export function stepsToNestedTree(
  steps: WorkflowStepDef[],
  fromAddressId?: number,
): WorkflowActionInput {
  if (steps.length === 0) throw new Error("At least one workflow step is required")

  function convertStep(step: WorkflowStepDef): WorkflowActionInput {
    const normalizedType = step.type.toLowerCase() as WorkflowActionType
    const isWait = normalizedType === WorkflowActionType.Wait
    const typeValue = isWait ? parseWorkflowDuration(String(step.value)) : Number(step.value)
    const node = buildWorkflowActionNode(normalizedType, typeValue, step.label, step.condition, fromAddressId, {
      fromDisplayName: step.fromDisplayName,
      replyToAddress: step.replyToAddress,
      replyToDisplayName: step.replyToDisplayName,
    })
    if (step.children && step.children.length > 0) {
      node.children = step.children.map(convertStep)
    }
    return node
  }

  const root = convertStep(steps[0]!)
  let current = root
  for (let i = 1; i < steps.length; i++) {
    const next = convertStep(steps[i]!)
    current.children.push(next)
    current = next
  }
  return root
}

/*
  The API has no per-action endpoints: a workflow's action tree is replaced
  atomically by PUT /workflows/:id. The helpers below mutate the tree returned
  by GET so a caller can append or remove a single step and PUT the record
  back. Nodes returned by the API carry action_id, which is how we address
  existing steps.
*/
export interface WorkflowActionNode {
  action_id?: number
  children?: WorkflowActionNode[] | null
  [key: string]: unknown
}

function findWorkflowAction(
  root: WorkflowActionNode,
  actionId: number,
): { node: WorkflowActionNode; parent: WorkflowActionNode | null } | undefined {
  const stack: Array<{ node: WorkflowActionNode; parent: WorkflowActionNode | null }> = [{ node: root, parent: null }]
  while (stack.length > 0) {
    const entry = stack.pop()!
    if (entry.node.action_id === actionId) return entry
    for (const child of entry.node.children ?? []) stack.push({ node: child, parent: entry.node })
  }
  return undefined
}

/*
  Appends a step to the tree. Without a parent it goes at the end of the main
  spine (following the last child at each level), which is where a new drip
  email belongs. With a parent it becomes that node's last child. Returns the
  new root so an empty workflow can receive its first step.
*/
export function appendWorkflowAction(
  root: WorkflowActionNode | null | undefined,
  step: WorkflowActionNode,
  parentActionId?: number,
): WorkflowActionNode {
  if (!root) return step
  let target: WorkflowActionNode
  if (parentActionId !== undefined) {
    const found = findWorkflowAction(root, parentActionId)
    if (!found) throw new Error(`Parent action ${parentActionId} not found in workflow`)
    target = found.node
  } else {
    target = root
    while (target.children && target.children.length > 0) {
      target = target.children[target.children.length - 1]!
    }
  }
  target.children = [...(target.children ?? []), step]
  return root
}

/*
  Removes a step and splices its children into its former position so the
  rest of the flow stays connected. Removing the root promotes its first child
  (any siblings of that child move under it) and returns null when the tree
  becomes empty.
*/
export function removeWorkflowAction(
  root: WorkflowActionNode,
  actionId: number,
): WorkflowActionNode | null {
  const found = findWorkflowAction(root, actionId)
  if (!found) throw new Error(`Action ${actionId} not found in workflow`)
  const orphans = found.node.children ?? []
  if (!found.parent) {
    const [promoted, ...rest] = orphans
    if (!promoted) return null
    if (rest.length > 0) promoted.children = [...(promoted.children ?? []), ...rest]
    return promoted
  }
  const siblings = found.parent.children ?? []
  const index = siblings.indexOf(found.node)
  found.parent.children = [...siblings.slice(0, index), ...orphans, ...siblings.slice(index + 1)]
  return root
}

/*
  The email-templates list endpoint ignores `page`; it paginates by an id
  cursor (`after_id`) and only orders by id when that cursor is non-zero.
  Ask for an explicit id sort on the first page so the cursor walk is stable
  from the start. The API rejects sort and after_id together, so only one is
  ever sent. folder_id 0 is the API's spelling for "unfiled". Archived
  templates are excluded unless asked for, matching the web app's list.
*/
export function emailTemplatePageQuery(
  limit: number,
  afterId: number,
  folderId?: number,
  archived = false,
): Record<string, string | number | string[]> {
  const query: Record<string, string | number | string[]> = {
    limit,
    "filter[]": [`is_archive:eq:${archived}`],
  }
  if (afterId > 0) query["after_id"] = afterId
  else query["sort"] = "id:asc"
  if (folderId !== undefined) query["folderId"] = folderId
  return query
}

export function nextAfterId(items: unknown[], limit: number): number | null {
  if (items.length < limit) return null
  const last = items[items.length - 1] as { id?: unknown } | undefined
  return typeof last?.id === "number" ? last.id : null
}
