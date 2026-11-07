import {
  KnowledgeLevel,
  KNOWLEDGE_LEVELS,
  KNOWLEDGE_CATEGORY_DEFAULT_COLOR,
  knowledgeLevelOf,
  knowledgeScopeLabel,
  knowledgeListFilters,
  effectiveKnowledgeQuery,
  effectiveContextForUnit,
  knowledgeStacksForUnit,
  knowledgeEntryBody,
  resolveKnowledgeTypeId,
  resolveKnowledgeCategoryIds,
  type KnowledgeScope,
} from "@sendsquared/client"
import { apiForRequest, envelope, asString, asOptString, asOptNumber, asOptBoolean } from "./shared.js"
import type { ToolDefinition } from "./types.js"

type Row = Record<string, unknown>

const KNOWLEDGE_PATH = "/knowledge/"

function idArg(args: Row, name: string): string {
  const value = args[name]
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value)
  }
  return asString(value, name)
}

const SCOPE_PROPS = {
  level: { type: "string", enum: KNOWLEDGE_LEVELS, description: "Scope level; implied by brand_id / group_code / property_code / unit_id, needed only for company" },
  brand_id: { type: "number", description: "Brand id (brand level)" },
  group_code: { type: "string", description: "Group code (group level)" },
  property_code: { type: "string", description: "Property code (property level)" },
  unit_id: { type: "number", description: "Unit id (unit level)" },
}

/*
  Exactly one scope value is accepted: the API keeps whichever scope column
  is set first and the entry would otherwise sit on two levels at once.
*/
export function scopeFromArgs(args: Row): KnowledgeScope | undefined {
  const given: Array<[KnowledgeLevel, unknown]> = []
  if (args["brand_id"] !== undefined) given.push([KnowledgeLevel.Brand, args["brand_id"]])
  if (args["group_code"] !== undefined) given.push([KnowledgeLevel.Group, args["group_code"]])
  if (args["property_code"] !== undefined) given.push([KnowledgeLevel.Property, args["property_code"]])
  if (args["unit_id"] !== undefined) given.push([KnowledgeLevel.Unit, args["unit_id"]])
  if (given.length > 1) {
    throw new Error("pass only one of brand_id, group_code, property_code, unit_id")
  }
  const level = asOptString(args["level"]) as KnowledgeLevel | undefined
  if (level !== undefined && !KNOWLEDGE_LEVELS.includes(level)) {
    throw new Error(`level must be one of: ${KNOWLEDGE_LEVELS.join(", ")}`)
  }
  if (given.length === 0) {
    if (level === undefined) return undefined
    if (level !== KnowledgeLevel.Company) {
      throw new Error(`level ${level} needs the matching scope value`)
    }
    return { level }
  }
  const [impliedLevel, value] = given[0]!
  if (level !== undefined && level !== impliedLevel) {
    throw new Error(`level ${level} does not match the scope value given`)
  }
  switch (impliedLevel) {
    case KnowledgeLevel.Brand:
      return { level: impliedLevel, brandId: asOptNumber(value) }
    case KnowledgeLevel.Unit:
      return { level: impliedLevel, unitId: asOptNumber(value) }
    case KnowledgeLevel.Group:
      return { level: impliedLevel, groupCode: String(value) }
    case KnowledgeLevel.Property:
      return { level: impliedLevel, propertyCode: String(value) }
    case KnowledgeLevel.Company:
      return { level: impliedLevel }
  }
}

function summary(entry: Row): Row {
  const type = (entry["knowledge_type"] ?? {}) as Row
  return {
    id: entry["id"],
    title: entry["title"],
    type: type["name"] ?? entry["knowledge_type_id"],
    level: knowledgeLevelOf(entry),
    scope: knowledgeScopeLabel(entry),
    active: entry["is_active"],
    categories: entry["category_ids"],
  }
}

async function types(): Promise<Row[]> {
  return ((await apiForRequest().get("/knowledge-types/")) ?? []) as Row[]
}

async function categories(): Promise<Row[]> {
  return ((await apiForRequest().get("/knowledge-categories/")) ?? []) as Row[]
}

function refList(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of ids or names`)
  }
  return value.map(String)
}

async function entryBody(args: Row, current?: Row): Promise<Record<string, unknown>> {
  const typeRef = asOptString(args["type"]) ?? (args["type_id"] !== undefined ? String(args["type_id"]) : undefined)
  const typeId = typeRef !== undefined ? resolveKnowledgeTypeId(await types(), typeRef) : undefined
  const categoryRefs = refList(args["categories"], "categories")
  const categoryIds = categoryRefs !== undefined ? resolveKnowledgeCategoryIds(await categories(), categoryRefs) : undefined
  return knowledgeEntryBody(current, {
    typeId,
    content: asOptString(args["content"]),
    title: asOptString(args["title"]),
    active: asOptBoolean(args["active"]),
    categoryIds,
    scope: scopeFromArgs(args),
  })
}

const USED_BY = "The SendSquared AI agent reads these when answering guest SMS and voice inquiries."

export const knowledgeList: ToolDefinition = {
  name: "sendsquared_knowledge_list",
  description:
    "List AI knowledge entries: the policies and instructions (check-in, parking, pets, Wi-Fi, ...) the SendSquared AI agent answers guests from. " +
    "Each entry has one knowledge type and one scope: company, brand, group code, property code, or unit. Scope arguments filter to entries on exactly that scope. " +
    "Returns a summary per entry; sendsquared_knowledge_get has the full content.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", description: "Knowledge type id or name" },
      categories: { type: "array", items: { type: "string" }, description: "Category ids or names; entries with any of them match" },
      search: { type: "string", description: "Match in title or content" },
      active: { type: "boolean", description: "Only active (true) or inactive (false) entries" },
      limit: { type: "number", default: 100, description: "Max 1000" },
      after_id: { type: "number", default: 0 },
      ...SCOPE_PROPS,
    },
  },
  handler: async (args) => {
    const typeRef = asOptString(args["type"])
    const typeId = typeRef !== undefined ? resolveKnowledgeTypeId(await types(), typeRef) : undefined
    const categoryRefs = refList(args["categories"], "categories")
    const categoryIds = categoryRefs !== undefined ? resolveKnowledgeCategoryIds(await categories(), categoryRefs) : undefined
    const scope = scopeFromArgs(args)
    const data = await apiForRequest().list<Row>(KNOWLEDGE_PATH, {
      limit: asOptNumber(args["limit"]) ?? 100,
      after_id: asOptNumber(args["after_id"]) ?? 0,
      filter: knowledgeListFilters({
        typeId,
        search: asOptString(args["search"]),
        level: scope?.level,
        brandId: scope?.brandId,
        groupCode: scope?.groupCode,
        propertyCode: scope?.propertyCode,
        unitId: scope?.unitId,
        active: asOptBoolean(args["active"]),
      }),
      category_ids: categoryIds,
    })
    return envelope({ entries: data.data.map(summary), total: data.total }, `${data.total} knowledge entries`, [
      "sendsquared_knowledge_get",
      "sendsquared_knowledge_create",
      "sendsquared_knowledge_effective",
    ])
  },
}

export const knowledgeGet: ToolDefinition = {
  name: "sendsquared_knowledge_get",
  description: "Get one AI knowledge entry with its full content, type, scope and categories.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number", description: "Knowledge entry id" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    const data = ((await apiForRequest().get(`/knowledge/${encodeURIComponent(id)}`)) ?? {}) as Row
    if (data["id"] === undefined) {
      throw new Error(`Knowledge ${id} not found`)
    }
    return envelope({ summary: summary(data), entry: data }, `Knowledge ${id}: ${String(data["title"] ?? "")} (${knowledgeScopeLabel(data)})`, ["sendsquared_knowledge_update"])
  },
}

export const knowledgeCreate: ToolDefinition = {
  name: "sendsquared_knowledge_create",
  description:
    "Add an AI knowledge entry. " + USED_BY + " Needs a knowledge type (id or name) and the content text; company level unless a scope value is given. " +
    "The most specific active entry per type wins when the AI resolves a unit, so a unit-level entry overrides a company-level one of the same type.",
  inputSchema: {
    type: "object",
    required: ["type", "content"],
    properties: {
      type: { type: "string", description: "Knowledge type id or name (sendsquared_knowledge_types_list)" },
      content: { type: "string", description: "The knowledge text, written as the answer the AI should give" },
      title: { type: "string", description: "Short title (max 255)" },
      categories: { type: "array", items: { type: "string" }, description: "Category ids or names" },
      active: { type: "boolean", default: true },
      ...SCOPE_PROPS,
    },
  },
  handler: async (args) => {
    const scope = scopeFromArgs(args) ?? { level: KnowledgeLevel.Company }
    const body = await entryBody({ ...args, level: scope.level }, undefined)
    const data = ((await apiForRequest().post(KNOWLEDGE_PATH, body)) ?? {}) as Row
    return envelope({ summary: summary(data), entry: data }, `Knowledge ${String(data["id"])} created on ${knowledgeScopeLabel(data)}`, ["sendsquared_knowledge_effective"])
  },
}

export const knowledgeUpdate: ToolDefinition = {
  name: "sendsquared_knowledge_update",
  description: "Change an AI knowledge entry; only the fields passed change. A scope value moves the entry to that level. categories replaces the whole set.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "number" },
      type: { type: "string", description: "Knowledge type id or name" },
      content: { type: "string" },
      title: { type: "string" },
      categories: { type: "array", items: { type: "string" } },
      active: { type: "boolean" },
      ...SCOPE_PROPS,
    },
  },
  handler: async (args) => {
    const id = idArg(args, "id")
    const api = apiForRequest()
    const current = ((await api.get(`/knowledge/${encodeURIComponent(id)}`)) ?? {}) as Row
    if (current["id"] === undefined) {
      throw new Error(`Knowledge ${id} not found`)
    }
    const data = ((await api.put(`/knowledge/${encodeURIComponent(id)}`, await entryBody(args, current))) ?? {}) as Row
    return envelope({ summary: summary(data), entry: data }, `Knowledge ${id} updated`)
  },
}

export const knowledgeDelete: ToolDefinition = {
  name: "sendsquared_knowledge_delete",
  description: "Delete an AI knowledge entry. Destructive — there is no undo. To stop the AI using an entry while keeping it, update it with active: false.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    await apiForRequest().delete(`/knowledge/${encodeURIComponent(id)}`)
    return envelope(null, `Knowledge ${id} deleted`, ["sendsquared_knowledge_list"])
  },
}

export const knowledgeSetCategories: ToolDefinition = {
  name: "sendsquared_knowledge_set_categories",
  description: "Replace the categories on an AI knowledge entry with the given set (ids or names). Categories organize entries and do not change what the AI reads.",
  inputSchema: {
    type: "object",
    required: ["id", "categories"],
    properties: { id: { type: "number" }, categories: { type: "array", items: { type: "string" } } },
  },
  handler: async (args) => {
    const id = idArg(args, "id")
    const ids = resolveKnowledgeCategoryIds(await categories(), refList(args["categories"], "categories") ?? [])
    const data = await apiForRequest().put(`/knowledge/${encodeURIComponent(id)}/categories`, ids)
    return envelope({ category_ids: data }, `Knowledge ${id} categories set`)
  },
}

export const knowledgeEffective: ToolDefinition = {
  name: "sendsquared_knowledge_effective",
  description:
    "What the AI will actually see for a context: the winning active entry per knowledge type, resolved company → brand → group → property → unit with the most specific winning. " +
    "Pass any mix of brand_id, group_code, property_code and unit_id, or none for the company view. Each result names its source_level. sendsquared_knowledge_by_unit builds the context from a unit record.",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", description: "Only this knowledge type (id or name)" },
      brand_id: { type: "number" },
      group_code: { type: "string" },
      property_code: { type: "string" },
      unit_id: { type: "number" },
    },
  },
  handler: async (args) => {
    const query = effectiveKnowledgeQuery({
      brandId: asOptNumber(args["brand_id"]),
      groupCode: asOptString(args["group_code"]),
      propertyCode: asOptString(args["property_code"]),
      unitId: asOptNumber(args["unit_id"]),
    })
    const typeRef = asOptString(args["type"])
    if (typeRef !== undefined) {
      const typeId = resolveKnowledgeTypeId(await types(), typeRef)
      const data = await apiForRequest().get(`/knowledge/effective/${typeId}`, query)
      return envelope(data, `Effective knowledge for type ${typeId}`)
    }
    const data = ((await apiForRequest().get("/knowledge/effective", query)) ?? []) as Row[]
    return envelope(data, `${data.length} effective knowledge entries`, ["sendsquared_knowledge_by_unit"])
  },
}

export const knowledgeByUnit: ToolDefinition = {
  name: "sendsquared_knowledge_by_unit",
  description: "Every policy that lands on a unit, per knowledge type, with each layer it could come from (unit, property, group, brand, company) and which one wins. The unit's own codes are looked up first. sendsquared_knowledge_effective returns only the winners.",
  inputSchema: { type: "object", required: ["unit_id"], properties: { unit_id: { type: "number" } } },
  handler: async (args) => {
    const unitId = idArg(args, "unit_id")
    const api = apiForRequest()
    const unit = ((await api.get(`/units/${encodeURIComponent(unitId)}`)) ?? {}) as Row
    if (unit["id"] === undefined) {
      throw new Error(`Unit ${unitId} not found`)
    }
    const context = effectiveContextForUnit(unit)
    const page = await api.list<Row>(KNOWLEDGE_PATH, { limit: 1000, after_id: 0 })
    const stacks = knowledgeStacksForUnit(page.data, context).map((stack) => ({
      type: stack.knowledge_type_name,
      knowledge_type_id: stack.knowledge_type_id,
      winner: stack.winner ? summary(stack.winner) : null,
      layers: stack.layers.map((layer) => ({ ...summary(layer.entry), wins: layer.wins, content: layer.entry["content"] })),
    }))
    return envelope(
      {
        unit: { id: unit["id"], name: unit["name"], property_code: context.propertyCode ?? null, group_code: context.groupCode ?? null, brand_id: context.brandId ?? null },
        stacks,
        ...(page.total > 1000 ? { warning: `only the first 1000 of ${page.total} entries were considered; some layers may be missing` } : {}),
      },
      `${stacks.length} knowledge types land on unit ${unitId}`,
      ["sendsquared_knowledge_effective", "sendsquared_knowledge_create"],
    )
  },
}

export const knowledgeTypesList: ToolDefinition = {
  name: "sendsquared_knowledge_types_list",
  description: "List knowledge types: the topic buckets (Check-in, Parking, Pets, ...) the AI chooses from when it looks something up. The AI reads each type's description to decide which types fit a question.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await types()
    return envelope(data, `${data.length} knowledge types`, ["sendsquared_knowledge_types_create", "sendsquared_knowledge_list"])
  },
}

export const knowledgeTypesCreate: ToolDefinition = {
  name: "sendsquared_knowledge_types_create",
  description: "Create a knowledge type. The description matters: the AI uses it to decide which types are relevant to a guest's question.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", description: "1–255 chars" }, description: { type: "string", description: "What questions this type answers" } },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const data = await apiForRequest().post("/knowledge-types/", { name, description: asOptString(args["description"]) })
    return envelope(data, `Knowledge type created: ${name}`, ["sendsquared_knowledge_create"])
  },
}

export const knowledgeTypesUpdate: ToolDefinition = {
  name: "sendsquared_knowledge_types_update",
  description: "Rename a knowledge type or change its description.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" }, name: { type: "string" }, description: { type: "string" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    const body: Row = {}
    const name = asOptString(args["name"])
    const description = asOptString(args["description"])
    if (name !== undefined) body["name"] = name
    if (description !== undefined) body["description"] = description
    const data = await apiForRequest().put(`/knowledge-types/${encodeURIComponent(id)}`, body)
    return envelope(data, `Knowledge type ${id} updated`)
  },
}

export const knowledgeTypesDelete: ToolDefinition = {
  name: "sendsquared_knowledge_types_delete",
  description: "Delete a knowledge type. Destructive — there is no undo; entries of that type are kept but no longer resolve for the AI.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    await apiForRequest().delete(`/knowledge-types/${encodeURIComponent(id)}`)
    return envelope(null, `Knowledge type ${id} deleted`, ["sendsquared_knowledge_types_list"])
  },
}

export const knowledgeCategoriesList: ToolDefinition = {
  name: "sendsquared_knowledge_categories_list",
  description: "List knowledge categories: colored tags for organizing entries. An entry can carry any number; they do not affect what the AI reads.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await categories()
    return envelope(data, `${data.length} knowledge categories`, ["sendsquared_knowledge_categories_create"])
  },
}

export const knowledgeCategoriesCreate: ToolDefinition = {
  name: "sendsquared_knowledge_categories_create",
  description: "Create a knowledge category (tag) with a chip color.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "1–255 chars" },
      description: { type: "string" },
      color: { type: "string", description: `Hex color; default ${KNOWLEDGE_CATEGORY_DEFAULT_COLOR}` },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const data = await apiForRequest().post("/knowledge-categories/", {
      name,
      description: asOptString(args["description"]),
      color: asOptString(args["color"]) ?? KNOWLEDGE_CATEGORY_DEFAULT_COLOR,
    })
    return envelope(data, `Knowledge category created: ${name}`)
  },
}

export const knowledgeCategoriesUpdate: ToolDefinition = {
  name: "sendsquared_knowledge_categories_update",
  description: "Rename a knowledge category or change its description or color.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "number" }, name: { type: "string" }, description: { type: "string" }, color: { type: "string" } },
  },
  handler: async (args) => {
    const id = idArg(args, "id")
    const body: Row = {}
    for (const key of ["name", "description", "color"]) {
      const value = asOptString(args[key])
      if (value !== undefined) body[key] = value
    }
    const data = await apiForRequest().put(`/knowledge-categories/${encodeURIComponent(id)}`, body)
    return envelope(data, `Knowledge category ${id} updated`)
  },
}

export const knowledgeCategoriesDelete: ToolDefinition = {
  name: "sendsquared_knowledge_categories_delete",
  description: "Delete a knowledge category. Destructive — there is no undo; it is removed from every entry that carried it.",
  inputSchema: { type: "object", required: ["id"], properties: { id: { type: "number" } } },
  handler: async (args) => {
    const id = idArg(args, "id")
    await apiForRequest().delete(`/knowledge-categories/${encodeURIComponent(id)}`)
    return envelope(null, `Knowledge category ${id} deleted`, ["sendsquared_knowledge_categories_list"])
  },
}

export const knowledgeTools: ToolDefinition[] = [
  knowledgeList,
  knowledgeGet,
  knowledgeCreate,
  knowledgeUpdate,
  knowledgeDelete,
  knowledgeSetCategories,
  knowledgeEffective,
  knowledgeByUnit,
  knowledgeTypesList,
  knowledgeTypesCreate,
  knowledgeTypesUpdate,
  knowledgeTypesDelete,
  knowledgeCategoriesList,
  knowledgeCategoriesCreate,
  knowledgeCategoriesUpdate,
  knowledgeCategoriesDelete,
]
