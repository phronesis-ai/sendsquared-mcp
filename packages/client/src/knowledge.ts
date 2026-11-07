export enum KnowledgeLevel {
  Company = "company",
  Brand = "brand",
  Group = "group",
  Property = "property",
  Unit = "unit",
}

export const KNOWLEDGE_LEVELS = [KnowledgeLevel.Company, KnowledgeLevel.Brand, KnowledgeLevel.Group, KnowledgeLevel.Property, KnowledgeLevel.Unit]

export const KNOWLEDGE_CATEGORY_DEFAULT_COLOR = "#607d8b"

export interface KnowledgeScope {
  level: KnowledgeLevel
  brandId?: number
  groupCode?: string
  propertyCode?: string
  unitId?: number
}

/*
  An entry's level is not stored; the API derives it from whichever scope
  column is set, most specific first (unit > property > group > brand >
  company). Writing a scope therefore means setting exactly one column and
  nulling the rest, or an edited entry can end up on two levels at once.
*/
export function knowledgeScopeFields(scope: KnowledgeScope): Record<string, unknown> {
  const fields: Record<string, unknown> = { brand_id: null, group_code: null, property_code: null, unit_id: null }
  switch (scope.level) {
    case KnowledgeLevel.Company:
      break
    case KnowledgeLevel.Brand:
      if (scope.brandId === undefined) {
        throw new Error("brand level needs a brand id")
      }
      fields["brand_id"] = scope.brandId
      break
    case KnowledgeLevel.Group:
      if (!scope.groupCode) {
        throw new Error("group level needs a group code")
      }
      fields["group_code"] = scope.groupCode
      break
    case KnowledgeLevel.Property:
      if (!scope.propertyCode) {
        throw new Error("property level needs a property code")
      }
      fields["property_code"] = scope.propertyCode
      break
    case KnowledgeLevel.Unit:
      if (scope.unitId === undefined) {
        throw new Error("unit level needs a unit id")
      }
      fields["unit_id"] = scope.unitId
      break
  }
  return fields
}

export function knowledgeLevelOf(entry: Record<string, unknown>): KnowledgeLevel {
  if (entry["unit_id"] !== null && entry["unit_id"] !== undefined) {
    return KnowledgeLevel.Unit
  }
  if (entry["property_code"]) {
    return KnowledgeLevel.Property
  }
  if (entry["group_code"]) {
    return KnowledgeLevel.Group
  }
  if (entry["brand_id"] !== null && entry["brand_id"] !== undefined) {
    return KnowledgeLevel.Brand
  }
  return KnowledgeLevel.Company
}

export function knowledgeScopeLabel(entry: Record<string, unknown>): string {
  switch (knowledgeLevelOf(entry)) {
    case KnowledgeLevel.Unit:
      return `unit ${String(entry["unit_id"])}`
    case KnowledgeLevel.Property:
      return `property ${String(entry["property_code"])}`
    case KnowledgeLevel.Group:
      return `group ${String(entry["group_code"])}`
    case KnowledgeLevel.Brand:
      return `brand ${String(entry["brand_id"])}`
    case KnowledgeLevel.Company:
      return "company"
  }
}

export interface KnowledgeListOptions {
  typeId?: number
  search?: string
  level?: KnowledgeLevel
  brandId?: number
  groupCode?: string
  propertyCode?: string
  unitId?: number
  active?: boolean
}

/*
  Same filter grammar the web list uses: attr:op:value, a trailing :or joins
  neighbours, and a colon inside the search text would be read as a separator
  so it is dropped. Level is not a column, so a level filter becomes a
  null / notNull test on the scope columns.
*/
export function knowledgeListFilters(opts: KnowledgeListOptions): string[] {
  const filters: string[] = []
  if (opts.typeId !== undefined) {
    filters.push(`knowledge_type_id:eq:${opts.typeId}`)
  }
  if (opts.search) {
    const q = opts.search.replace(/:/g, "").trim()
    if (q) {
      filters.push(`title:ilike:%${q}%:or`, `content:ilike:%${q}%:or`)
    }
  }
  if (opts.brandId !== undefined) {
    filters.push(`brand_id:eq:${opts.brandId}`)
  }
  if (opts.groupCode) {
    filters.push(`group_code:eq:${opts.groupCode}`)
  }
  if (opts.propertyCode) {
    filters.push(`property_code:eq:${opts.propertyCode}`)
  }
  if (opts.unitId !== undefined) {
    filters.push(`unit_id:eq:${opts.unitId}`)
  }
  if (opts.active !== undefined) {
    filters.push(`is_active:eq:${opts.active}`)
  }
  switch (opts.level) {
    case KnowledgeLevel.Unit:
      filters.push("unit_id:notNull")
      break
    case KnowledgeLevel.Property:
      filters.push("unit_id:null", "property_code:notNull")
      break
    case KnowledgeLevel.Group:
      filters.push("unit_id:null", "property_code:null", "group_code:notNull")
      break
    case KnowledgeLevel.Brand:
      filters.push("unit_id:null", "property_code:null", "group_code:null", "brand_id:notNull")
      break
    case KnowledgeLevel.Company:
      filters.push("unit_id:null", "property_code:null", "group_code:null", "brand_id:null")
      break
    case undefined:
      break
  }
  return filters
}

export interface EffectiveContext {
  brandId?: number
  groupCode?: string
  propertyCode?: string
  unitId?: number
}

export function effectiveKnowledgeQuery(ctx: EffectiveContext): Record<string, string | number | undefined> {
  return {
    brandId: ctx.brandId,
    groupCode: ctx.groupCode,
    propertyCode: ctx.propertyCode,
    unitId: ctx.unitId,
  }
}

/*
  A unit carries the codes the AI resolves knowledge through, so "what does
  the AI know for this unit" is the effective query built from the unit
  record itself.
*/
export function effectiveContextForUnit(unit: Record<string, unknown>): EffectiveContext {
  const brand = unit["brand_id"] ?? unit["guidebook_brand_id"]
  return {
    unitId: Number(unit["id"]),
    propertyCode: unit["property_code"] ? String(unit["property_code"]) : undefined,
    groupCode: unit["group_code"] ? String(unit["group_code"]) : undefined,
    brandId: brand === null || brand === undefined ? undefined : Number(brand),
  }
}

export interface KnowledgeEntryInput {
  typeId: number
  content: string
  title?: string | null
  active?: boolean
  categoryIds?: number[]
  scope?: KnowledgeScope
}

/*
  PUT patches rather than replaces, but still insists on type and content, so
  an update is built from the current record with the changes laid over it.
  Categories are only sent when they change, since sending them replaces the
  whole set.
*/
export function knowledgeEntryBody(current: Record<string, unknown> | undefined, input: Partial<KnowledgeEntryInput>): Record<string, unknown> {
  const typeId = input.typeId ?? (current ? Number(current["knowledge_type_id"]) : undefined)
  const content = input.content ?? (current ? String(current["content"] ?? "") : undefined)
  if (typeId === undefined || !Number.isInteger(typeId)) {
    throw new Error("a knowledge type is required")
  }
  if (content === undefined || content.trim().length === 0) {
    throw new Error("content is required")
  }
  const body: Record<string, unknown> = { knowledge_type_id: typeId, content }
  if (input.title !== undefined) {
    body["title"] = input.title
  }
  if (input.active !== undefined) {
    body["is_active"] = input.active
  } else if (!current) {
    body["is_active"] = true
  }
  if (input.categoryIds !== undefined) {
    body["category_ids"] = [...new Set(input.categoryIds)]
  }
  if (input.scope !== undefined) {
    Object.assign(body, knowledgeScopeFields(input.scope))
  }
  return body
}

export function resolveKnowledgeTypeId(types: Array<Record<string, unknown>>, ref: string): number {
  if (/^\d+$/.test(ref.trim())) {
    const id = parseInt(ref, 10)
    if (!types.some((t) => Number(t["id"]) === id)) {
      throw new Error(`knowledge type ${id} does not exist in this company (see knowledge types list)`)
    }
    return id
  }
  const wanted = ref.trim().toLowerCase()
  const matches = types.filter((t) => String(t["name"] ?? "").trim().toLowerCase() === wanted)
  if (matches.length === 1) {
    return Number(matches[0]!["id"])
  }
  if (matches.length === 0) {
    throw new Error(`no knowledge type named "${ref}" (see knowledge types list)`)
  }
  throw new Error(`more than one knowledge type is named "${ref}"; use the id`)
}

export function resolveKnowledgeCategoryIds(categories: Array<Record<string, unknown>>, refs: string[]): number[] {
  const ids: number[] = []
  for (const ref of refs) {
    if (/^\d+$/.test(ref.trim())) {
      const id = parseInt(ref, 10)
      if (!categories.some((c) => Number(c["id"]) === id)) {
        throw new Error(`knowledge category ${id} does not exist in this company (see knowledge categories list)`)
      }
      ids.push(id)
      continue
    }
    const wanted = ref.trim().toLowerCase()
    const match = categories.find((c) => String(c["name"] ?? "").trim().toLowerCase() === wanted)
    if (!match) {
      throw new Error(`no knowledge category named "${ref}" (see knowledge categories list)`)
    }
    ids.push(Number(match["id"]))
  }
  return [...new Set(ids)]
}

export interface KnowledgeLayer {
  level: KnowledgeLevel
  entry: Record<string, unknown>
  wins: boolean
}

export interface KnowledgeStack {
  knowledge_type_id: number
  knowledge_type_name: string
  winner: Record<string, unknown> | null
  layers: KnowledgeLayer[]
}

const LEVEL_RANK: Record<KnowledgeLevel, number> = {
  [KnowledgeLevel.Company]: 1,
  [KnowledgeLevel.Brand]: 2,
  [KnowledgeLevel.Group]: 3,
  [KnowledgeLevel.Property]: 4,
  [KnowledgeLevel.Unit]: 5,
}

function appliesToUnit(entry: Record<string, unknown>, ctx: EffectiveContext): boolean {
  switch (knowledgeLevelOf(entry)) {
    case KnowledgeLevel.Company:
      return true
    case KnowledgeLevel.Brand:
      return ctx.brandId !== undefined && Number(entry["brand_id"]) === ctx.brandId
    case KnowledgeLevel.Group:
      return ctx.groupCode !== undefined && String(entry["group_code"]) === ctx.groupCode
    case KnowledgeLevel.Property:
      return ctx.propertyCode !== undefined && String(entry["property_code"]) === ctx.propertyCode
    case KnowledgeLevel.Unit:
      return ctx.unitId !== undefined && Number(entry["unit_id"]) === ctx.unitId
  }
}

/*
  The web app's Knowledge By Unit screen: for every knowledge type, each
  layer that applies to the unit from most to least specific, with the
  winner marked. The winner is the most specific active layer, the same rule
  the API applies in /knowledge/effective; inactive layers are shown but
  never win.
*/
export function knowledgeStacksForUnit(entries: Array<Record<string, unknown>>, ctx: EffectiveContext): KnowledgeStack[] {
  const byType = new Map<number, KnowledgeStack>()
  for (const entry of entries) {
    if (entry["deleted_at"]) continue
    if (!appliesToUnit(entry, ctx)) continue
    const typeId = Number(entry["knowledge_type_id"])
    const type = (entry["knowledge_type"] ?? {}) as Record<string, unknown>
    const stack = byType.get(typeId) ?? { knowledge_type_id: typeId, knowledge_type_name: String(type["name"] ?? typeId), winner: null, layers: [] }
    stack.layers.push({ level: knowledgeLevelOf(entry), entry, wins: false })
    byType.set(typeId, stack)
  }
  for (const stack of byType.values()) {
    stack.layers.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || Number(b.entry["id"]) - Number(a.entry["id"]))
    const winner = stack.layers.find((layer) => layer.entry["is_active"] !== false)
    if (winner) {
      winner.wins = true
      stack.winner = winner.entry
    }
  }
  return [...byType.values()].sort((a, b) => a.knowledge_type_name.localeCompare(b.knowledge_type_name))
}
