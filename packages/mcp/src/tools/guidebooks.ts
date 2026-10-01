import { apiForRequest, envelope, asString, asOptString, asOptNumber, asNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

const BLOCK_TYPES = ["identity", "houseGuides", "houseAccess", "areaGuides", "localGuides", "restaurantGuides", "activityGuides", "otherGuides", "legalTerms", "vehicleInfo"]

export const guidebooksList: ToolDefinition = {
  name: "sendsquared_guidebooks_list",
  description: "List all SendSquared digital guidebooks for this company with pagination.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 25 },
      after_id: { type: "number", default: 0, description: "Cursor-based pagination, pass the last id from previous page" },
      search: { type: "string", description: "Case-insensitive substring match on name or public_name" },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 25
    const after_id = asOptNumber(args["after_id"]) ?? 0
    const filter = nameSearchFilters(asOptString(args["search"]))
    const result = await apiForRequest().list("/guidebooks", { limit, after: after_id, filter })
    return envelope(
      { guidebooks: result.data, total: result.total },
      `${result.total} guidebooks`,
      ["sendsquared_guidebooks_get", "sendsquared_guidebooks_create"],
    )
  },
}

export const guidebooksGet: ToolDefinition = {
  name: "sendsquared_guidebooks_get",
  description:
    "Fetch a single SendSquared guidebook by id, including all its blocks and their assets. " +
    "The block content embedded in this response can lag behind recent edits — the backend caches the embedded " +
    "block payload independently of the underlying block records. The authoritative content for a specific " +
    "block (e.g. to verify an update) is what sendsquared_guidebook_blocks_get returns, not the embedded " +
    "copy here. The block ORDER in the returned array IS authoritative for this guidebook " +
    "(it reflects the per-guidebook render order set by sendsquared_guidebooks_reorder_blocks).",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = ((await apiForRequest().get(`/guidebooks/${encodeURIComponent(id)}`)) ?? {}) as Record<string, unknown>
    const summary = data["deleted_at"] ? `Guidebook ${id} (DELETED ${String(data["deleted_at"])})` : `Guidebook ${id}`
    return envelope(data, summary, [
      "sendsquared_guidebooks_update",
      "sendsquared_guidebook_blocks_list",
      "sendsquared_guidebooks_add_blocks",
      "sendsquared_guidebooks_assign_units",
    ])
  },
}

/*
  The guidebook API stores map data but never derives it — that work happens in
  the SPA's Places picker, which is why a block created through the API came out
  with google_places_id, latitude, longitude, map_link, and location_name all
  null even when given a full address, and therefore rendered to guests with no
  map pin. The lookup the picker uses is itself an API endpoint
  (/google/place-detail/{placeId}), so we can reproduce it here: whenever a
  caller supplies google_places_id we fetch the same detail record and stamp the
  same fields the picker does. Anything the caller passed explicitly wins, so
  this fills gaps rather than overwriting intent.

  Field-for-field this matches handlePlaceSelection in GuidebookBlockEdit.vue.
  One deliberate difference: that function builds address_1 by concatenating
  street_number and route unguarded, which yields the string "undefined
  undefined" for places that have neither. We drop the missing parts instead.

  rating is NOT stamped — the UI binds it to a manual star input rather than
  taking Google's score, so deriving it here would put a number in front of
  guests that no one chose.
*/
interface PlaceAddressComponent {
  long_name?: string
  short_name?: string
  types?: string[]
}

interface PlaceDetailResult {
  place_id?: string
  name?: string
  website?: string
  url?: string
  formatted_phone_number?: string
  editorial_summary?: { overview?: string }
  geometry?: { location?: { lat?: number; lng?: number } }
  address_components?: PlaceAddressComponent[]
}

function componentValue(
  components: PlaceAddressComponent[],
  type: string,
  form: "long_name" | "short_name" = "long_name",
): string | undefined {
  const match = components.find((c) => Array.isArray(c.types) && c.types.includes(type))
  return match?.[form]
}

async function stampPlaceDetail(placeId: string, body: Record<string, unknown>): Promise<string[]> {
  const detail = await apiForRequest().get<{ result?: PlaceDetailResult }>(
    `/google/place-detail/${encodeURIComponent(placeId)}`,
  )
  const place = detail?.result
  if (!place) return []

  const components = place.address_components ?? []
  const streetNumber = componentValue(components, "street_number")
  const route = componentValue(components, "route")
  const address1 = [streetNumber, route].filter(Boolean).join(" ")

  const derived: Record<string, unknown> = {
    google_places_id: place.place_id,
    location_name: place.name,
    address_1: address1 || undefined,
    locality: componentValue(components, "locality"),
    region: componentValue(components, "administrative_area_level_1", "short_name"),
    postal_code: componentValue(components, "postal_code"),
    latitude: place.geometry?.location?.lat,
    longitude: place.geometry?.location?.lng,
    external_link: place.website,
    map_link: place.url,
    description: place.editorial_summary?.overview,
    phone_number: place.formatted_phone_number,
  }

  const stamped: string[] = []
  for (const [key, value] of Object.entries(derived)) {
    if (value === undefined || value === null || value === "") continue
    if (body[key] !== undefined && body[key] !== "") continue
    body[key] = value
    stamped.push(key)
  }
  return stamped
}

/*
  The list endpoints take no ad-hoc query keys — tsoa only binds limit, after,
  offset, filter[] and sort[], and anything else is dropped silently. So a
  filter has to be expressed the way the SPA does it, as "field:op:value"
  strings, with a trailing ":or" to OR adjacent clauses. The earlier
  block_type=... query param never filtered anything; every block came back.
*/
export function nameSearchFilters(search: string | undefined): string[] {
  if (!search) return []
  return [`name:ilike:%${search}%:or`, `public_name:ilike:%${search}%:or`]
}

export function blockListFilters(blockType: string | undefined, search: string | undefined): string[] {
  const filters: string[] = []
  if (blockType) filters.push(`guidebook_block_type:eq:${blockType}`)
  filters.push(...nameSearchFilters(search))
  return filters
}

/*
  Fields that exist on the API's GuidebookInputModel but were never exposed by
  the create/update tools, so they were unreachable from Claude — most visibly
  public_unit_listing and theme_id. Shared by both handlers so the two schemas
  cannot drift apart again. Only keys the caller actually supplied are copied,
  which keeps update a genuine partial PATCH.
*/
const GUIDEBOOK_OPTIONAL_STRINGS = ["verification_method", "logo_alignment", "google_analytics_measurement_id"]
const GUIDEBOOK_OPTIONAL_NUMBERS = ["theme_id", "brand_id", "guest_invite_limit", "logo_width", "sms_chat_campaign_id"]
const GUIDEBOOK_OPTIONAL_BOOLEANS = ["public_unit_listing", "public_listing", "allow_guest_invites"]

function applyOptionalGuidebookFields(args: Record<string, unknown>, body: Record<string, unknown>): void {
  for (const f of GUIDEBOOK_OPTIONAL_STRINGS) {
    const v = asOptString(args[f])
    if (v) body[f] = v
  }
  for (const f of GUIDEBOOK_OPTIONAL_NUMBERS) {
    if (args[f] !== undefined) body[f] = asOptNumber(args[f])
  }
  for (const f of GUIDEBOOK_OPTIONAL_BOOLEANS) {
    if (typeof args[f] === "boolean") body[f] = args[f]
  }
}

export const guidebooksCreate: ToolDefinition = {
  name: "sendsquared_guidebooks_create",
  description:
    "Create a new SendSquared digital guidebook. A guidebook is a guest-facing property guide " +
    "that contains blocks (house access, area guides, restaurant recommendations, etc.). " +
    "After creating, add blocks with sendsquared_guidebook_blocks_create and assign to units " +
    "with sendsquared_guidebooks_assign_units.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Internal guidebook name" },
      description: { type: "string", description: "Internal description" },
      active: { type: "boolean", default: true },
      theme: { type: "string", description: "Visual theme name" },
      primary_color: { type: "string", description: "Primary brand color (hex, e.g. #2563eb)" },
      secondary_color: { type: "string", description: "Secondary color (hex)" },
      background_color: { type: "string", description: "Background color (hex)" },
      access_days_before: { type: "number", description: "Days before check-in the guidebook becomes accessible to the guest" },
      access_days_after: { type: "number", description: "Days after checkout the guidebook remains accessible" },
      address_access_days_before: { type: "number", description: "Days before check-in the address becomes visible" },
      address_access_days_after: { type: "number", description: "Days after checkout the address remains visible" },
      pdf_exportable: { type: "boolean", description: "Allow guests to export as PDF" },
      hide_price: { type: "boolean", description: "Hide unit price on the guidebook" },
      hide_email: { type: "boolean", description: "Hide email on the guidebook" },
      hide_phone_number: { type: "boolean", description: "Hide phone number on the guidebook" },
      show_all_images: { type: "boolean", description: "Show all images by default" },
      collapsible_headers: { type: "boolean", description: "Make section headers collapsible" },
      default_collapsed: { type: "boolean", description: "Start sections collapsed" },
      trip_advisor_link: { type: "string", description: "TripAdvisor review link to display" },
      google_local_link: { type: "string", description: "Google review link to display" },
      public_name: { type: "string", description: "Public-facing guidebook name" },
      background_asset_id: { type: "number", description: "Asset id for the background image" },
      public_unit_listing: { type: "boolean", description: "Reservation-free per-unit preview at /g/u/<unit uuid>" },
      public_listing: { type: "boolean", description: "Publish the whole guidebook at /g/p/<company uuid> for anyone without a reservation. Check-in, legal and vehicle blocks are excluded from the public render." },
      theme_id: { type: "number", description: "Guidebook theme id (see sendsquared_guidebook_themes_list)" },
      brand_id: { type: "number", description: "Brand id to associate with this guidebook" },
      verification_method: {
        type: "string",
        enum: ["last_name_reservation", "email_checkin"],
        description: "How guests verify themselves to open the guidebook",
      },
      allow_guest_invites: { type: "boolean", description: "Let guests invite others to the guidebook" },
      guest_invite_limit: { type: "number", description: "Max guest invites (1-25). The API rejects values outside that range." },
      logo_width: { type: "number", description: "Logo width in pixels" },
      logo_alignment: { type: "string", enum: ["left", "center", "right"], description: "Logo alignment" },
      google_analytics_measurement_id: { type: "string", description: "GA4 measurement id for guidebook traffic" },
      sms_chat_campaign_id: { type: "number", description: "SMS chat campaign id to attach" },
    },
  },
  /*
    The SendSquared API 500s when create payloads omit the boolean/numeric
    flags that the web app's create form always supplies — even though they
    look optional. We default every field to the same value the form's data()
    refs use, then let the caller override.
  */
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const body: Record<string, unknown> = {
      name,
      description: asOptString(args["description"]) ?? "",
      active: typeof args["active"] === "boolean" ? args["active"] : true,
      theme: asOptString(args["theme"]) ?? "",
      access_days_before: asOptNumber(args["access_days_before"]) ?? 0,
      access_days_after: asOptNumber(args["access_days_after"]) ?? 0,
      address_access_days_before: asOptNumber(args["address_access_days_before"]) ?? 0,
      address_access_days_after: asOptNumber(args["address_access_days_after"]) ?? 0,
      pdf_exportable: typeof args["pdf_exportable"] === "boolean" ? args["pdf_exportable"] : false,
      primary_color: asOptString(args["primary_color"]) ?? "#409EFF",
      secondary_color: asOptString(args["secondary_color"]) ?? "#67C23A",
      background_color: asOptString(args["background_color"]) ?? "#ffffff",
      hide_price: typeof args["hide_price"] === "boolean" ? args["hide_price"] : false,
      hide_email: typeof args["hide_email"] === "boolean" ? args["hide_email"] : false,
      hide_phone_number: typeof args["hide_phone_number"] === "boolean" ? args["hide_phone_number"] : false,
      show_all_images: typeof args["show_all_images"] === "boolean" ? args["show_all_images"] : false,
      collapsible_headers: typeof args["collapsible_headers"] === "boolean" ? args["collapsible_headers"] : false,
      default_collapsed: typeof args["default_collapsed"] === "boolean" ? args["default_collapsed"] : false,
    }
    const tripAdvisorLink = asOptString(args["trip_advisor_link"])
    const googleLocalLink = asOptString(args["google_local_link"])
    const publicName = asOptString(args["public_name"])
    const backgroundAssetId = asOptNumber(args["background_asset_id"])
    if (tripAdvisorLink) body["trip_advisor_link"] = tripAdvisorLink
    if (googleLocalLink) body["google_local_link"] = googleLocalLink
    if (publicName) body["public_name"] = publicName
    if (backgroundAssetId !== undefined) body["background_asset_id"] = backgroundAssetId
    applyOptionalGuidebookFields(args, body)

    const data = await apiForRequest().post("/guidebooks", body)
    return envelope(data, `Guidebook created: ${name}`, [
      "sendsquared_guidebook_blocks_create",
      "sendsquared_guidebooks_add_blocks",
      "sendsquared_guidebooks_assign_units",
    ])
  },
}

export const guidebooksUpdate: ToolDefinition = {
  name: "sendsquared_guidebooks_update",
  description: "Update a SendSquared guidebook's properties (name, description, theme, colors, access window, display flags, etc.). Only fields you pass are changed.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      active: { type: "boolean" },
      theme: { type: "string" },
      primary_color: { type: "string" },
      secondary_color: { type: "string" },
      background_color: { type: "string" },
      access_days_before: { type: "number" },
      access_days_after: { type: "number" },
      address_access_days_before: { type: "number" },
      address_access_days_after: { type: "number" },
      pdf_exportable: { type: "boolean" },
      hide_price: { type: "boolean" },
      hide_email: { type: "boolean" },
      hide_phone_number: { type: "boolean" },
      show_all_images: { type: "boolean" },
      collapsible_headers: { type: "boolean" },
      default_collapsed: { type: "boolean" },
      trip_advisor_link: { type: "string" },
      google_local_link: { type: "string" },
      public_name: { type: "string" },
      background_asset_id: { type: "number" },
      public_unit_listing: { type: "boolean", description: "Reservation-free per-unit preview at /g/u/<unit uuid>" },
      public_listing: { type: "boolean", description: "Publish the whole guidebook at /g/p/<company uuid> for anyone without a reservation. Check-in, legal and vehicle blocks are excluded from the public render." },
      theme_id: { type: "number", description: "Guidebook theme id (see sendsquared_guidebook_themes_list)" },
      brand_id: { type: "number", description: "Brand id to associate with this guidebook" },
      verification_method: {
        type: "string",
        enum: ["last_name_reservation", "email_checkin"],
        description: "How guests verify themselves to open the guidebook",
      },
      allow_guest_invites: { type: "boolean", description: "Let guests invite others to the guidebook" },
      guest_invite_limit: { type: "number", description: "Max guest invites (1-25). The API rejects values outside that range." },
      logo_width: { type: "number", description: "Logo width in pixels" },
      logo_alignment: { type: "string", enum: ["left", "center", "right"], description: "Logo alignment" },
      google_analytics_measurement_id: { type: "string", description: "GA4 measurement id for guidebook traffic" },
      sms_chat_campaign_id: { type: "number", description: "SMS chat campaign id to attach" },
    },
  },
  /*
    Guidebooks are updated via PATCH — the API has no PUT route for this
    resource (PUT returns 404 "Invalid route"). The web app's
    guidebookServices.updateGuidebook uses PATCH; we mirror it.
  */
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = {}
    const name = asOptString(args["name"])
    const desc = asOptString(args["description"])
    const theme = asOptString(args["theme"])
    if (name) body["name"] = name
    if (desc !== undefined) body["description"] = desc
    if (typeof args["active"] === "boolean") body["active"] = args["active"]
    if (theme !== undefined) body["theme"] = theme
    if (asOptString(args["primary_color"])) body["primary_color"] = args["primary_color"]
    if (asOptString(args["secondary_color"])) body["secondary_color"] = args["secondary_color"]
    if (asOptString(args["background_color"])) body["background_color"] = args["background_color"]
    if (args["access_days_before"] !== undefined) body["access_days_before"] = asOptNumber(args["access_days_before"])
    if (args["access_days_after"] !== undefined) body["access_days_after"] = asOptNumber(args["access_days_after"])
    if (args["address_access_days_before"] !== undefined) body["address_access_days_before"] = asOptNumber(args["address_access_days_before"])
    if (args["address_access_days_after"] !== undefined) body["address_access_days_after"] = asOptNumber(args["address_access_days_after"])
    if (typeof args["pdf_exportable"] === "boolean") body["pdf_exportable"] = args["pdf_exportable"]
    if (typeof args["hide_price"] === "boolean") body["hide_price"] = args["hide_price"]
    if (typeof args["hide_email"] === "boolean") body["hide_email"] = args["hide_email"]
    if (typeof args["hide_phone_number"] === "boolean") body["hide_phone_number"] = args["hide_phone_number"]
    if (typeof args["show_all_images"] === "boolean") body["show_all_images"] = args["show_all_images"]
    if (typeof args["collapsible_headers"] === "boolean") body["collapsible_headers"] = args["collapsible_headers"]
    if (typeof args["default_collapsed"] === "boolean") body["default_collapsed"] = args["default_collapsed"]
    if (asOptString(args["trip_advisor_link"])) body["trip_advisor_link"] = args["trip_advisor_link"]
    if (asOptString(args["google_local_link"])) body["google_local_link"] = args["google_local_link"]
    if (asOptString(args["public_name"])) body["public_name"] = args["public_name"]
    if (asOptNumber(args["background_asset_id"]) !== undefined) body["background_asset_id"] = asOptNumber(args["background_asset_id"])
    applyOptionalGuidebookFields(args, body)

    const client = apiForRequest()
    await liveGuidebook(client, id)
    const data = await client.patch(`/guidebooks/${encodeURIComponent(id)}`, body)
    return envelope(data, `Guidebook ${id} updated`, ["sendsquared_guidebooks_get"])
  },
}

export const guidebooksDuplicate: ToolDefinition = {
  name: "sendsquared_guidebooks_duplicate",
  description: "Duplicate a SendSquared guidebook with a new name. Copies all blocks and assignments.",
  inputSchema: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "string" },
      name: { type: "string", description: "Name for the new copy" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const name = asString(args["name"], "name")
    const data = await apiForRequest().post(`/guidebooks/duplicate/${encodeURIComponent(id)}`, { name })
    return envelope(data, `Guidebook ${id} duplicated as "${name}"`, ["sendsquared_guidebooks_get"])
  },
}

export const guidebooksDelete: ToolDefinition = {
  name: "sendsquared_guidebooks_delete",
  description: "Delete a SendSquared guidebook. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/guidebooks/${encodeURIComponent(id)}`)
    return envelope(null, `Guidebook ${id} deleted`, ["sendsquared_guidebooks_list"])
  },
}

/*
  The /guidebooks/units/{id} endpoint REPLACES the entire unit list. A naive
  POST with only the new IDs wipes everything else attached. To get
  add/remove semantics we fetch the guidebook's current units, modify the
  set, then post the full result back — the same read-modify-write pattern
  contact tagging uses. Two concurrent calls on one guidebook can drop units.
  The API lets a unit sit on two guidebooks (guests see the newest), so assign
  refuses that unless `move` is set, and ids from another company are dropped
  by the API and reported back as skipped.
*/
async function liveGuidebook(client: ReturnType<typeof apiForRequest>, id: string): Promise<Record<string, unknown>> {
  const guidebook = ((await client.get(`/guidebooks/${encodeURIComponent(id)}`)) ?? {}) as Record<string, unknown>
  if (guidebook["deleted_at"]) {
    throw new Error(`Guidebook ${id} was deleted at ${String(guidebook["deleted_at"])}; guests no longer see it, so edits to it have no effect`)
  }
  return guidebook
}

function requestedIds(value: unknown, name: string): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array of numbers`)
  }
  const ids = value.map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`${name} must be positive integer ids`)
  }
  return ids
}

function currentGuidebookUnitIds(guidebook: Record<string, unknown>): number[] {
  const units = Array.isArray(guidebook["units"]) ? guidebook["units"] : []
  const ids: number[] = []
  for (const u of units) {
    const n = Number((u as Record<string, unknown>)?.["id"])
    if (Number.isFinite(n)) ids.push(n)
  }
  return ids
}

export const guidebooksAssignUnits: ToolDefinition = {
  name: "sendsquared_guidebooks_assign_units",
  description:
    "Add one or more units to a guidebook. Existing units are preserved — the tool fetches the " +
    "current unit list, unions in the new IDs, and writes back the full result (the underlying " +
    "setUnits API is a REPLACE, so passing only new IDs would wipe everything else). " +
    "Fails if a unit is already on another guidebook unless move is true, which takes it off that " +
    "guidebook first. Ids that are not units in this company come back in `skipped`.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "unitIds"],
    properties: {
      guidebookId: { type: "string" },
      unitIds: { type: "array", items: { type: "number" }, description: "Unit ids to add" },
      move: { type: "boolean", description: "Take the units off any other guidebook they are on" },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const requested = requestedIds(args["unitIds"], "unitIds")
    const client = apiForRequest()
    const guidebook = await liveGuidebook(client, guidebookId)
    const assignments = ((await client.get("/guidebooks/unit-assignments")) ?? []) as Array<{
      unit_id: number
      guidebook_id: number
      guidebook_name: string
    }>
    const wanted = new Set(requested)
    const conflicts = assignments.filter((a) => wanted.has(a.unit_id) && a.guidebook_id !== parseInt(guidebookId, 10))
    if (conflicts.length > 0 && args["move"] !== true) {
      const list = conflicts.map((c) => `unit ${c.unit_id} is on guidebook ${c.guidebook_id} (${c.guidebook_name})`).join("; ")
      throw new Error(`${list}. Call again with move: true to take them off, or unassign them there first`)
    }
    const byGuidebook = new Map<number, Set<number>>()
    for (const c of conflicts) {
      const set = byGuidebook.get(c.guidebook_id) ?? new Set<number>()
      set.add(c.unit_id)
      byGuidebook.set(c.guidebook_id, set)
    }
    for (const [otherId, leaving] of byGuidebook) {
      const other = ((await client.get(`/guidebooks/${otherId}`)) ?? {}) as Record<string, unknown>
      await client.post(`/guidebooks/units/${otherId}`, currentGuidebookUnitIds(other).filter((u) => !leaving.has(u)))
    }
    const merged = new Set([...currentGuidebookUnitIds(guidebook), ...requested])
    const data = ((await client.post(`/guidebooks/units/${encodeURIComponent(guidebookId)}`, [...merged])) ?? {}) as Record<string, unknown>
    const attached = new Set(currentGuidebookUnitIds(data))
    const skipped = requested.filter((id) => !attached.has(id))
    const moved = conflicts.map((c) => c.unit_id)
    return envelope(
      { guidebook: data, moved, skipped },
      `guidebook ${guidebookId} now attached to ${attached.size} unit(s)` +
        (moved.length > 0 ? `; moved ${moved.join(", ")}` : "") +
        (skipped.length > 0 ? `; skipped ${skipped.join(", ")} (not a unit in this company)` : ""),
      ["sendsquared_guidebooks_get", "sendsquared_guidebooks_unassign_units"],
    )
  },
}

export const guidebooksUnassignUnits: ToolDefinition = {
  name: "sendsquared_guidebooks_unassign_units",
  description:
    "Remove one or more units from a guidebook. Other units stay attached — the tool fetches the " +
    "current unit list, drops the supplied IDs, and writes back the full result. Lets you clean up " +
    "stale or mis-assigned records (including foreign-company IDs that the UI hides) without " +
    "rebuilding the whole guidebook.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "unitIds"],
    properties: {
      guidebookId: { type: "string" },
      unitIds: { type: "array", items: { type: "number" }, description: "Unit ids to remove" },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const requested = requestedIds(args["unitIds"], "unitIds")
    const client = apiForRequest()
    const current = currentGuidebookUnitIds(await liveGuidebook(client, guidebookId))
    const currentSet = new Set(current)
    const notOnGuidebook = requested.filter((id) => !currentSet.has(id))
    const remove = new Set(requested)
    const remaining = current.filter((id) => !remove.has(id))
    const data = await client.post(`/guidebooks/units/${encodeURIComponent(guidebookId)}`, remaining)
    return envelope(
      { guidebook: data, not_on_guidebook: notOnGuidebook },
      `guidebook ${guidebookId} now attached to ${remaining.length} unit(s)` +
        (notOnGuidebook.length > 0 ? `; ${notOnGuidebook.join(", ")} were not on it` : ""),
      ["sendsquared_guidebooks_get", "sendsquared_guidebooks_assign_units"],
    )
  },
}

export const guidebooksBlockTypes: ToolDefinition = {
  name: "sendsquared_guidebook_block_types",
  description:
    "List the available block types for guidebooks: Identity, HouseGuides, HouseAccess, " +
    "AreaGuides, LocalGuides, RestaurantGuides, ActivityGuides, OtherGuides, LegalTerms.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/guidebooks/block-types")
    return envelope(data, "Available guidebook block types", [
      "sendsquared_guidebook_blocks_create",
    ])
  },
}

export const guidebookBlocksList: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_list",
  description: "List all guidebook blocks for this company. Blocks are reusable across multiple guidebooks.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", default: 25 },
      after_id: { type: "number", default: 0 },
      block_type: {
        type: "string",
        enum: BLOCK_TYPES,
        description: "Filter by block type (e.g. restaurantGuides, areaGuides)",
      },
      search: { type: "string", description: "Case-insensitive substring match on name or public_name" },
    },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 25
    const after_id = asOptNumber(args["after_id"]) ?? 0
    const filter = blockListFilters(asOptString(args["block_type"]), asOptString(args["search"]))
    const result = await apiForRequest().list("/guidebooks/blocks", { limit, after: after_id, filter })
    return envelope(
      { blocks: result.data, total: result.total },
      `${result.total} guidebook blocks`,
      ["sendsquared_guidebook_blocks_get", "sendsquared_guidebook_blocks_create"],
    )
  },
}

export const guidebookBlocksGet: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_get",
  description: "Fetch a single guidebook block by id, including its assets.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/guidebooks/block/${encodeURIComponent(id)}`)
    return envelope(data, `Guidebook block ${id}`, [
      "sendsquared_guidebook_blocks_update",
      "sendsquared_guidebooks_add_blocks",
    ])
  },
}

/*
  Block fields the SPA's editor writes that the tools did not expose. The
  legal-terms toggles decide what a guest must do at signing time, and
  hide_when_verified is the identity block's "collapse once checked in" switch.
  Without them a legalTerms block created through here could only ever carry
  the database defaults. Shared by create, update and batch create so the three
  schemas stay in step.
*/
const BLOCK_OPTIONAL_STRINGS = ["public_name", "address_1", "address_2", "locality", "region", "postal_code", "google_places_id", "phone_number", "external_link", "map_link", "location_name"]
const BLOCK_OPTIONAL_NUMBERS = ["latitude", "longitude", "rating", "verification_assets"]
const BLOCK_LEGAL_BOOLEANS = [
  "require_acceptance_first",
  "require_email",
  "require_cancellation_acknowledgement",
  "require_signature",
  "collect_party_members",
  "collect_first_name",
  "collect_last_name",
  "collect_phone",
  "collect_birthday",
  "collect_checkin_time",
  "collect_checkout_time",
  "collect_marketing_consent",
]
const BLOCK_OPTIONAL_BOOLEANS = ["hide_when_verified", ...BLOCK_LEGAL_BOOLEANS]

export function applyOptionalBlockFields(args: Record<string, unknown>, body: Record<string, unknown>): void {
  for (const f of BLOCK_OPTIONAL_STRINGS) {
    const v = asOptString(args[f])
    if (v) body[f] = v
  }
  for (const f of BLOCK_OPTIONAL_NUMBERS) {
    if (args[f] !== undefined) body[f] = asOptNumber(args[f])
  }
  for (const f of BLOCK_OPTIONAL_BOOLEANS) {
    if (typeof args[f] === "boolean") body[f] = args[f]
  }
}

const BLOCK_FLAG_SCHEMA: Record<string, unknown> = {
  verification_assets: { type: "number", description: "Number of verification photos/files the guest must upload for this block" },
  hide_when_verified: { type: "boolean", description: "identity blocks only: hide the block once the guest has verified/checked in" },
  require_acceptance_first: { type: "boolean", description: "legalTerms: guest must accept before the rest of the guidebook unlocks" },
  require_email: { type: "boolean", description: "legalTerms: require an email address when signing" },
  require_cancellation_acknowledgement: { type: "boolean", description: "legalTerms: require the guest to acknowledge the cancellation policy" },
  require_signature: { type: "boolean", description: "legalTerms: require a drawn signature" },
  collect_party_members: { type: "boolean", description: "legalTerms: collect the names of everyone in the party" },
  collect_first_name: { type: "boolean", description: "legalTerms: collect first name at signing" },
  collect_last_name: { type: "boolean", description: "legalTerms: collect last name at signing" },
  collect_phone: { type: "boolean", description: "legalTerms: require a phone number at signing" },
  collect_birthday: { type: "boolean", description: "legalTerms: collect birthday (optional for the guest)" },
  collect_checkin_time: { type: "boolean", description: "legalTerms: require planned check-in time" },
  collect_checkout_time: { type: "boolean", description: "legalTerms: require planned check-out time" },
  collect_marketing_consent: { type: "boolean", description: "legalTerms: offer a marketing opt-in checkbox" },
}

export const guidebookBlocksCreate: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_create",
  description:
    "Create a new guidebook block. Block types: Identity (property intro), HouseGuides (house rules/info), " +
    "HouseAccess (door codes, WiFi, parking), AreaGuides (neighborhood info), LocalGuides (local tips), " +
    "RestaurantGuides (dining recommendations), ActivityGuides (things to do), OtherGuides (miscellaneous), " +
    "LegalTerms (policies). Blocks are reusable — create once, add to multiple guidebooks.",
  inputSchema: {
    type: "object",
    required: ["name", "guidebook_block_type", "description"],
    properties: {
      name: { type: "string", description: "Internal block name" },
      public_name: { type: "string", description: "Guest-facing display name" },
      guidebook_block_type: { type: "string", enum: BLOCK_TYPES, description: "Block type" },
      description: {
        type: "string",
        description:
          "Block content shown to guests (supports HTML). REQUIRED — the API's model validation lists " +
          "description among its required fields and throws on creates without it, surfacing as a 500. " +
          "Pass a single space if the block genuinely has no body copy.",
      },
      address_1: { type: "string", description: "Street address (for location-based blocks like restaurants)" },
      address_2: { type: "string" },
      locality: { type: "string", description: "City" },
      region: { type: "string", description: "State/region" },
      postal_code: { type: "string" },
      google_places_id: {
        type: "string",
        description:
          "Google place_id from sendsquared_places_search. Supplying it auto-fills location_name, " +
          "latitude, longitude, map_link, address, phone_number, and external_link from Google — any " +
          "of those you pass explicitly are kept. Without it the block has no map pin.",
      },
      phone_number: { type: "string", description: "Contact phone number" },
      external_link: { type: "string", description: "External website URL" },
      map_link: { type: "string", description: "Map URL for the location" },
      location_name: { type: "string", description: "Display name of the location on the map" },
      latitude: { type: "number", description: "Latitude. The API does not geocode addresses — supply this to get a map pin." },
      longitude: { type: "number", description: "Longitude. The API does not geocode addresses — supply this to get a map pin." },
      rating: { type: "number", description: "Rating to display (e.g. 4.5)" },
      access_days_before: { type: "number", description: "Days before check-in this block becomes visible" },
      access_days_after: { type: "number", description: "Days after checkout this block remains visible" },
      active: {
        type: "boolean",
        description:
          "Whether the block is visible to guests. Defaults to FALSE — a block created here is not geocoded " +
          "(see the note on map data below), so publishing it immediately would show guests a location with no " +
          "map pin. Set true explicitly once the block has been reviewed.",
        default: false,
      },
      display_order: {
        type: "number",
        description:
          "Block-level shared sort position. The SendSquared API requires this field and rejects creates without it with 422. " +
          "Defaults to 0 if omitted. Note: display_order is shared across every guidebook the block is attached to; " +
          "per-guidebook ordering is set with sendsquared_guidebooks_reorder_blocks.",
      },
      ...BLOCK_FLAG_SCHEMA,
    },
  },
  /*
    active was hardcoded true here, so every API-created block went live to
    guests the moment it was created, with no way for the caller to opt out —
    the field was not even in the schema. Reported 2026-08-20. It is now a
    caller-controlled field defaulting to false, because blocks created through
    this path never get the map data the UI's Places picker stamps on
    (google_places_id, latitude, longitude, map_link, location_name, rating all
    come back null), and a live block with no map pin is worse than an inactive
    one. Geocoding itself is server-side work — the API does not derive those
    fields from an address on its own.

    access_days_before / access_days_after are NOT NULL columns on
    guidebook_blocks with no database default, but the API's Objection schema
    does not list them as required, so omitting them passes validation and
    then fails at insert time as a bare 500 "Unexpected Error Occured".
    Reported 2026-09-12 on company 444. The SPA form always sends 0 for both;
    we do the same, matching what sendsquared_guidebooks_create already does.
  */
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const blockType = asString(args["guidebook_block_type"], "guidebook_block_type")
    const body: Record<string, unknown> = {
      name,
      guidebook_block_type: blockType,
      active: typeof args["active"] === "boolean" ? args["active"] : false,
      display_order: asOptNumber(args["display_order"]) ?? 0,
      description: asString(args["description"], "description"),
      access_days_before: asOptNumber(args["access_days_before"]) ?? 0,
      access_days_after: asOptNumber(args["access_days_after"]) ?? 0,
    }
    applyOptionalBlockFields(args, body)

    const placeId = asOptString(args["google_places_id"])
    const stamped = placeId ? await stampPlaceDetail(placeId, body) : []

    const data = await apiForRequest().post("/guidebooks/block", body)
    return envelope(
      data,
      stamped.length > 0
        ? `Block created: ${name} (${blockType}). Auto-filled from Google Places: ${stamped.join(", ")}.`
        : `Block created: ${name} (${blockType})`,
      ["sendsquared_guidebooks_add_blocks", "sendsquared_guidebook_blocks_get"],
    )
  },
}

export const guidebookBlocksUpdate: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_update",
  description:
    "Update a guidebook block's properties, content, or location data. " +
    "Blocks are reusable — every guidebook the block is attached to sees these edits. " +
    "Note: display_order on the block is a SHARED, block-level field and is NOT a per-guidebook position. " +
    "To set per-guidebook render order, use sendsquared_guidebooks_reorder_blocks. " +
    "Also: after an update, the embedded copy returned by sendsquared_guidebooks_get may be stale for several " +
    "minutes; re-fetch with sendsquared_guidebook_blocks_get to verify.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      public_name: { type: "string" },
      description: { type: "string" },
      address_1: { type: "string" },
      address_2: { type: "string" },
      locality: { type: "string" },
      region: { type: "string" },
      postal_code: { type: "string" },
      google_places_id: { type: "string" },
      phone_number: { type: "string", description: "Contact phone number" },
      external_link: { type: "string" },
      map_link: { type: "string", description: "Map URL for the location" },
      location_name: { type: "string", description: "Display name of the location on the map" },
      latitude: { type: "number", description: "Latitude. The API does not geocode addresses — supply this to get a map pin." },
      longitude: { type: "number", description: "Longitude. The API does not geocode addresses — supply this to get a map pin." },
      rating: { type: "number", description: "Rating to display (e.g. 4.5)" },
      active: { type: "boolean" },
      access_days_before: { type: "number" },
      access_days_after: { type: "number" },
      display_order: {
        type: "number",
        description:
          "Shared block-level sort position. Affects every guidebook the block is attached to. " +
          "For per-guidebook ordering, use sendsquared_guidebooks_reorder_blocks instead.",
      },
      ...BLOCK_FLAG_SCHEMA,
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = {}
    /*
      phone was the wrong field name. The column is phone_number, and tsoa is
      configured without noImplicitAdditionalProperties, so an unknown key is
      not rejected at the edge — it flows into the Objection update and dies at
      the database as an unknown column, which surfaces to the caller as a bare
      500. That made phone look unwritable on every format the reporter tried
      ((410) 289-1192, 4102891192, +14102891192); the format was never the
      problem, the key was. Same fix applied to create and batch create.
    */
    for (const f of ["name", "description"]) {
      const v = asOptString(args[f])
      if (v) body[f] = v
    }
    applyOptionalBlockFields(args, body)
    if (typeof args["active"] === "boolean") body["active"] = args["active"]
    if (args["access_days_before"] !== undefined) body["access_days_before"] = asOptNumber(args["access_days_before"])
    if (args["access_days_after"] !== undefined) body["access_days_after"] = asOptNumber(args["access_days_after"])
    if (args["display_order"] !== undefined) body["display_order"] = asOptNumber(args["display_order"])

    /*
      Block updates are PATCH /guidebooks/block/{id} — the API has no PUT
      route for this resource (PUT returns 404 "Invalid route"). Mirrors
      guidebookServices.updateBlock.
    */
    const placeId = asOptString(args["google_places_id"])
    const stamped = placeId ? await stampPlaceDetail(placeId, body) : []

    const data = await apiForRequest().patch(`/guidebooks/block/${encodeURIComponent(id)}`, body)
    return envelope(
      data,
      stamped.length > 0
        ? `Block ${id} updated. Auto-filled from Google Places: ${stamped.join(", ")}.`
        : `Block ${id} updated`,
      ["sendsquared_guidebook_blocks_get"],
    )
  },
}

export const guidebookBlocksDelete: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_delete",
  description: "Delete a guidebook block. Destructive — there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/guidebooks/block/${encodeURIComponent(id)}`)
    return envelope(null, `Block ${id} deleted`, ["sendsquared_guidebook_blocks_list"])
  },
}

export const guidebooksAddBlocks: ToolDefinition = {
  name: "sendsquared_guidebooks_add_blocks",
  description:
    "Add existing blocks to a guidebook. Blocks are reusable — the same block can appear in multiple guidebooks. " +
    "The raw API returns an empty `added` array for blocks already attached, and the `displayOrder` it echoes is " +
    "not always the final render position. This tool resolves both by fetching the guidebook after the call and " +
    "returning explicit `freshly_attached`, `already_attached`, and `final_render_order` lists.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "blockIds"],
    properties: {
      guidebookId: { type: "string" },
      blockIds: { type: "array", items: { type: "number" }, description: "Array of block ids to add" },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const blockIds = args["blockIds"]
    if (!Array.isArray(blockIds)) throw new Error("blockIds must be an array of numbers")
    const requested = blockIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    const api = apiForRequest()
    await liveGuidebook(api, guidebookId)
    const raw = await api.post<{ added?: unknown[] }>(
      `/guidebooks/block-add/${encodeURIComponent(guidebookId)}`,
      { blockIds: requested },
    )
    const rawAdded = Array.isArray(raw?.added)
      ? raw.added.map((entry) => {
          const e = entry as Record<string, unknown>
          const id = asOptNumber(e["id"] ?? e["blockId"] ?? e["block_id"])
          return typeof id === "number" ? id : null
        }).filter((v): v is number => v !== null)
      : []
    const guidebook = await api.get<{ blocks?: Array<{ id: number }> }>(
      `/guidebooks/${encodeURIComponent(guidebookId)}`,
    )
    const renderOrder = Array.isArray(guidebook.blocks) ? guidebook.blocks.map((b) => b.id) : []
    const renderSet = new Set(renderOrder)
    const freshlyAttached = requested.filter((id) => rawAdded.includes(id) && renderSet.has(id))
    const alreadyAttached = requested.filter((id) => !rawAdded.includes(id) && renderSet.has(id))
    const missing = requested.filter((id) => !renderSet.has(id))
    return envelope(
      {
        guidebookId,
        requested,
        freshly_attached: freshlyAttached,
        already_attached: alreadyAttached,
        not_attached: missing,
        final_render_order: renderOrder,
      },
      `${freshlyAttached.length} attached, ${alreadyAttached.length} already present` +
        (missing.length > 0 ? `, ${missing.length} not attached` : ""),
      ["sendsquared_guidebooks_get", "sendsquared_guidebooks_reorder_blocks"],
    )
  },
}

export const guidebooksRemoveBlocks: ToolDefinition = {
  name: "sendsquared_guidebooks_remove_blocks",
  description: "Remove blocks from a guidebook. Does not delete the blocks themselves — they remain available for other guidebooks.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "blockIds"],
    properties: {
      guidebookId: { type: "string" },
      blockIds: { type: "array", items: { type: "number" }, description: "Array of block ids to remove" },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const blockIds = args["blockIds"]
    if (!Array.isArray(blockIds)) throw new Error("blockIds must be an array of numbers")
    const client = apiForRequest()
    await liveGuidebook(client, guidebookId)
    const data = await client.post(`/guidebooks/block-remove/${encodeURIComponent(guidebookId)}`, { blockIds })
    return envelope(data, `Blocks removed from guidebook ${guidebookId}`, ["sendsquared_guidebooks_get"])
  },
}

export const guidebooksReorderBlocks: ToolDefinition = {
  name: "sendsquared_guidebooks_reorder_blocks",
  description:
    "Set the render order of blocks within a single guidebook. Pass an array of {key: blockId, value: position} pairs. " +
    "IMPORTANT: this writes to the per-guidebook ordering used by the renderer, not to the shared block.display_order " +
    "field. So subsequent fetches of the same block in OTHER guidebooks are unaffected, and the block.display_order " +
    "value returned by sendsquared_guidebook_blocks_get will NOT reflect the reorder. To verify the new order, fetch " +
    "the guidebook with sendsquared_guidebooks_get and inspect the array order of the returned blocks.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "blocks"],
    properties: {
      guidebookId: { type: "string" },
      blocks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            key: { type: "number", description: "Block id" },
            value: { type: "number", description: "Per-guidebook render position (0-indexed)" },
          },
        },
        description: "Array of {key: blockId, value: position}",
      },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const blocks = args["blocks"]
    if (!Array.isArray(blocks)) throw new Error("blocks must be an array")
    const api = apiForRequest()
    await liveGuidebook(api, guidebookId)
    await api.post(`/guidebooks/block-order/${encodeURIComponent(guidebookId)}`, { blocks })
    const verified = await api.get<{ blocks?: Array<{ id: number }> }>(
      `/guidebooks/${encodeURIComponent(guidebookId)}`,
    )
    const renderedOrder = Array.isArray(verified.blocks) ? verified.blocks.map((b) => b.id) : []
    return envelope(
      {
        guidebookId,
        requested: blocks,
        rendered_order: renderedOrder,
        note:
          "Per-guidebook render order updated. block.display_order on the underlying block records is unchanged — " +
          "that field is shared across guidebooks. Verify with the rendered_order array above.",
      },
      `Block render order updated for guidebook ${guidebookId} (verified ${renderedOrder.length} blocks)`,
      ["sendsquared_guidebooks_get"],
    )
  },
}

export const guidebookBlocksCreateBatch: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_create_batch",
  description:
    "Create multiple guidebook blocks in one call and optionally add them all to a guidebook. " +
    "Use this when populating a guidebook with many items — e.g. 10 restaurant recommendations, " +
    "5 local activities, or a full set of house guides. Each block in the array follows the same " +
    "schema as sendsquared_guidebook_blocks_create. If guidebookId is provided, all created blocks " +
    "are automatically added to that guidebook in the order specified.",
  inputSchema: {
    type: "object",
    required: ["blocks"],
    properties: {
      guidebookId: {
        type: "string",
        description: "If provided, all created blocks are auto-added to this guidebook in order",
      },
      blocks: {
        type: "array",
        description: "Array of block definitions to create",
        items: {
          type: "object",
          required: ["name", "guidebook_block_type", "description"],
          properties: {
            name: { type: "string", description: "Internal block name" },
            public_name: { type: "string", description: "Guest-facing display name" },
            guidebook_block_type: { type: "string", enum: BLOCK_TYPES },
            description: {
              type: "string",
              description: "Block content shown to guests (supports HTML). REQUIRED — creates without it fail with a 500.",
            },
            active: {
              type: "boolean",
              description: "Visible to guests. Defaults to false; blocks created here are not geocoded.",
              default: false,
            },
            address_1: { type: "string" },
            address_2: { type: "string" },
            locality: { type: "string" },
            region: { type: "string" },
            postal_code: { type: "string" },
            google_places_id: { type: "string" },
            phone_number: { type: "string" },
            external_link: { type: "string" },
            map_link: { type: "string" },
            location_name: { type: "string" },
            latitude: { type: "number" },
            longitude: { type: "number" },
            rating: { type: "number" },
            access_days_before: { type: "number", description: "Days before check-in this block becomes visible. Defaults to 0." },
            access_days_after: { type: "number", description: "Days after checkout this block remains visible. Defaults to 0." },
            display_order: {
              type: "number",
              description:
                "Optional block-level sort position. Defaults to the block's index in the array if omitted. " +
                "The SendSquared API rejects creates that omit display_order with 422.",
            },
            ...BLOCK_FLAG_SCHEMA,
          },
        },
      },
    },
  },
  handler: async (args) => {
    const blocks = args["blocks"]
    if (!Array.isArray(blocks) || blocks.length === 0) {
      throw new Error("blocks must be a non-empty array")
    }

    const api = apiForRequest()
    const created: Array<{ id: number; name: string; type: string }> = []
    const failed: Array<{ name: string; type: string; error: string }> = []

    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Record<string, unknown>
      const name = asString(b["name"], "name")
      const blockType = asString(b["guidebook_block_type"], "guidebook_block_type")
      const body: Record<string, unknown> = {
        name,
        guidebook_block_type: blockType,
        active: typeof b["active"] === "boolean" ? b["active"] : false,
        display_order: asOptNumber(b["display_order"]) ?? i,
        description: asString(b["description"], "description"),
        access_days_before: asOptNumber(b["access_days_before"]) ?? 0,
        access_days_after: asOptNumber(b["access_days_after"]) ?? 0,
      }
      applyOptionalBlockFields(b, body)
      const result = await api.post<{ id: number }>("/guidebooks/block", body).catch((err: unknown) => {
        failed.push({ name, type: blockType, error: err instanceof Error ? err.message : String(err) })
        return null
      })
      if (result) created.push({ id: result.id, name, type: blockType })
    }

    const guidebookId = asOptString(args["guidebookId"])
    if (guidebookId && created.length > 0) {
      const blockIds = created.map((c) => c.id)
      await api.post(`/guidebooks/block-add/${encodeURIComponent(guidebookId)}`, { blockIds })
    }

    return envelope(
      { created, failed, count: created.length, failed_count: failed.length, added_to_guidebook: guidebookId ?? null },
      `${created.length} blocks created${failed.length > 0 ? `, ${failed.length} failed` : ""}${guidebookId ? ` and added to guidebook ${guidebookId}` : ""}`,
      ["sendsquared_guidebooks_get", "sendsquared_guidebooks_reorder_blocks"],
    )
  },
}

/*
  Guidebook themes live on their own controller (/v1/guidebook-themes) rather
  than under /guidebooks, which is why they were missed when the guidebook tools
  were first written. A theme is a name plus raw html/css; the API sanitizes
  submitted markup and reports what it stripped, so a create or update that
  silently loses tags is expected behaviour, not a bug.
*/
export const guidebookThemesList: ToolDefinition = {
  name: "sendsquared_guidebook_themes_list",
  description:
    "List guidebook themes for this company. A theme is reusable html/css branding that guidebooks " +
    "reference by theme_id. Use before setting theme_id on a guidebook.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/guidebook-themes")
    return envelope(data, "Guidebook themes", [
      "sendsquared_guidebook_themes_get",
      "sendsquared_guidebook_themes_create",
    ])
  },
}

export const guidebookThemesGet: ToolDefinition = {
  name: "sendsquared_guidebook_themes_get",
  description: "Get a single guidebook theme, including its html and css.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Theme id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/guidebook-themes/${encodeURIComponent(id)}`)
    return envelope(data, `Guidebook theme ${id}`, ["sendsquared_guidebook_themes_update"])
  },
}

export const guidebookThemesCreate: ToolDefinition = {
  name: "sendsquared_guidebook_themes_create",
  description:
    "Create a guidebook theme from html and css. The API sanitizes the markup and returns an audit " +
    "of any tags, attributes, or css rules it removed — check that audit before assuming the theme " +
    "rendered as written.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Theme name" },
      html: { type: "string", description: "Theme HTML (sanitized server-side)" },
      css: { type: "string", description: "Theme CSS (sanitized server-side)" },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const body: Record<string, unknown> = { name }
    const html = asOptString(args["html"])
    const css = asOptString(args["css"])
    if (html !== undefined) body["html"] = html
    if (css !== undefined) body["css"] = css
    const data = await apiForRequest().post("/guidebook-themes", body)
    return envelope(
      data,
      `Guidebook theme created: ${name}. Check the 'audit' field — it lists any tags, attributes, or css the sanitizer removed.`,
      ["sendsquared_guidebook_themes_list"],
    )
  },
}

export const guidebookThemesUpdate: ToolDefinition = {
  name: "sendsquared_guidebook_themes_update",
  description: "Update a guidebook theme's name, html, or css. Only fields you pass are changed.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Theme id" },
      name: { type: "string" },
      html: { type: "string" },
      css: { type: "string" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = {}
    for (const f of ["name", "html", "css"]) {
      const v = asOptString(args[f])
      if (v !== undefined) body[f] = v
    }
    /*
      The API re-sanitizes on every update, using existing html/css for any
      field the caller omits — so a name-only change still re-runs the filter
      over the stored markup and can strip more than last time if the sanitize
      rules have moved. Always read the returned audit rather than assuming an
      update was lossless.
    */
    const data = await apiForRequest().patch(`/guidebook-themes/${encodeURIComponent(id)}`, body)
    return envelope(
      data,
      `Guidebook theme ${id} updated. Check the 'audit' field — it lists any tags, attributes, or css the sanitizer removed.`,
      ["sendsquared_guidebook_themes_get"],
    )
  },
}

export const guidebookThemesDelete: ToolDefinition = {
  name: "sendsquared_guidebook_themes_delete",
  description: "Delete a guidebook theme. Destructive — guidebooks referencing it lose their theme, and there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Theme id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/guidebook-themes/${encodeURIComponent(id)}`)
    return envelope(null, `Guidebook theme ${id} deleted`, ["sendsquared_guidebook_themes_list"])
  },
}

/*
  Conditions gate whether a guidebook (or an individual block) is shown to a
  given guest. Both endpoints are full replacements, not merges: the array you
  POST becomes the complete condition set, so read the current conditions first
  and send them back alongside any additions or the existing ones are dropped.
*/
const CONDITION_ITEM_SCHEMA = {
  type: "object",
  required: ["condition_block", "condition_type", "operand", "operator", "value", "value_type", "logic_type"],
  properties: {
    id: { type: "number", description: "Existing condition id; omit to create a new one" },
    condition_block: { type: "number", description: "Group index — conditions sharing a block are evaluated together" },
    condition_type: { type: "string", description: "Condition type" },
    operand: { type: "string", description: "Field being tested" },
    operator: { type: "string", description: "Comparison operator" },
    value: { type: "string", description: "Value to compare against" },
    value_type: { type: "string", description: "Type of the value" },
    logic_type: { type: "string", description: "How this condition joins the previous one (and/or)" },
  },
}

export const guidebooksConditionsGet: ToolDefinition = {
  name: "sendsquared_guidebooks_conditions_get",
  description:
    "Get the visibility conditions for a guidebook. Conditions decide which guests see the guidebook. " +
    "sendsquared_guidebooks_conditions_set replaces the entire set, so this is the list to resend from.",
  inputSchema: {
    type: "object",
    required: ["guidebookId"],
    properties: { guidebookId: { type: "string", description: "Guidebook id" } },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const data = await apiForRequest().get(`/guidebooks/conditions/${encodeURIComponent(guidebookId)}`)
    return envelope(data, `Conditions for guidebook ${guidebookId}`, ["sendsquared_guidebooks_conditions_set"])
  },
}

export const guidebooksConditionsSet: ToolDefinition = {
  name: "sendsquared_guidebooks_conditions_set",
  description:
    "Replace a guidebook's visibility conditions. REPLACES the whole set — any existing condition not " +
    "included in this call is deleted. sendsquared_guidebooks_conditions_get returns the current set " +
    "to resend from.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "conditions"],
    properties: {
      guidebookId: { type: "string", description: "Guidebook id" },
      conditions: {
        type: "array",
        description: "Complete condition set. An empty array clears all conditions.",
        items: CONDITION_ITEM_SCHEMA,
      },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const conditions = args["conditions"]
    if (!Array.isArray(conditions)) {
      throw new Error("conditions must be an array")
    }
    const withId = conditions.map((c) => ({ ...(c as Record<string, unknown>), guidebook_id: Number(guidebookId) }))
    const data = await apiForRequest().post(`/guidebooks/conditions/${encodeURIComponent(guidebookId)}`, withId)
    return envelope(data, `${withId.length} conditions set on guidebook ${guidebookId}`, [
      "sendsquared_guidebooks_conditions_get",
    ])
  },
}

export const guidebookBlocksConditionsGet: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_conditions_get",
  description:
    "Get the visibility conditions for a single guidebook block. " +
    "sendsquared_guidebook_blocks_conditions_set replaces the entire set, so this is the list to resend from.",
  inputSchema: {
    type: "object",
    required: ["blockId"],
    properties: { blockId: { type: "string", description: "Guidebook block id" } },
  },
  handler: async (args) => {
    const blockId = asString(args["blockId"], "blockId")
    const data = await apiForRequest().get(`/guidebooks/block-conditions/${encodeURIComponent(blockId)}`)
    return envelope(data, `Conditions for block ${blockId}`, ["sendsquared_guidebook_blocks_conditions_set"])
  },
}

export const guidebookBlocksConditionsSet: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_conditions_set",
  description:
    "Replace a guidebook block's visibility conditions. REPLACES the whole set — any existing " +
    "condition not included is deleted. sendsquared_guidebook_blocks_conditions_get returns the current set to resend from.",
  inputSchema: {
    type: "object",
    required: ["blockId", "conditions"],
    properties: {
      blockId: { type: "string", description: "Guidebook block id" },
      conditions: {
        type: "array",
        description: "Complete condition set. An empty array clears all conditions.",
        items: CONDITION_ITEM_SCHEMA,
      },
    },
  },
  handler: async (args) => {
    const blockId = asString(args["blockId"], "blockId")
    const conditions = args["conditions"]
    if (!Array.isArray(conditions)) {
      throw new Error("conditions must be an array")
    }
    const withId = conditions.map((c) => ({ ...(c as Record<string, unknown>), guidebook_block_id: Number(blockId) }))
    const data = await apiForRequest().post(`/guidebooks/block-conditions/${encodeURIComponent(blockId)}`, withId)
    return envelope(data, `${withId.length} conditions set on block ${blockId}`, [
      "sendsquared_guidebook_blocks_conditions_get",
    ])
  },
}

export const guidebookBlocksGuidebooksGet: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_guidebooks_get",
  description:
    "List the guidebook ids a block is attached to. Blocks are reusable, so this shows " +
    "everywhere an edit to the block will land.",
  inputSchema: {
    type: "object",
    required: ["blockId"],
    properties: { blockId: { type: "string", description: "Guidebook block id" } },
  },
  handler: async (args) => {
    const blockId = asString(args["blockId"], "blockId")
    const data = await apiForRequest().get(`/guidebooks/block/${encodeURIComponent(blockId)}/guidebooks`)
    return envelope(data, `Guidebooks containing block ${blockId}`, [
      "sendsquared_guidebook_blocks_guidebooks_set",
      "sendsquared_guidebook_blocks_get",
    ])
  },
}

export const guidebookBlocksGuidebooksSet: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_guidebooks_set",
  description:
    "Set exactly which guidebooks a block belongs to. REPLACES the block's whole membership list — " +
    "guidebooks omitted here lose the block. sendsquared_guidebook_blocks_guidebooks_get returns the current " +
    "list, and sendsquared_guidebooks_add_blocks adds without removing.",
  inputSchema: {
    type: "object",
    required: ["blockId", "guidebookIds"],
    properties: {
      blockId: { type: "string", description: "Guidebook block id" },
      guidebookIds: {
        type: "array",
        items: { type: "number" },
        description: "Complete list of guidebook ids this block should belong to",
      },
    },
  },
  handler: async (args) => {
    const blockId = asString(args["blockId"], "blockId")
    const guidebookIds = args["guidebookIds"]
    if (!Array.isArray(guidebookIds)) {
      throw new Error("guidebookIds must be an array of numbers")
    }
    const data = await apiForRequest().put(`/guidebooks/block/${encodeURIComponent(blockId)}/guidebooks`, {
      guidebookIds: guidebookIds.map((v) => Number(v)),
    })
    return envelope(data, `Block ${blockId} now belongs to ${guidebookIds.length} guidebooks`, [
      "sendsquared_guidebook_blocks_guidebooks_get",
    ])
  },
}

export const guidebooksUnitAssignments: ToolDefinition = {
  name: "sendsquared_guidebooks_unit_assignments",
  description:
    "List every unit-to-guidebook assignment for this company, with the guidebook name. Use to see " +
    "which units already have a guidebook and which are unassigned.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const data = await apiForRequest().get("/guidebooks/unit-assignments")
    return envelope(data, "Guidebook unit assignments", [
      "sendsquared_guidebooks_assign_units",
      "sendsquared_guidebooks_list",
    ])
  },
}

export const guidebooksSetBlockTypeOrder: ToolDefinition = {
  name: "sendsquared_guidebooks_set_block_type_order",
  description:
    "Set the order in which block TYPE sections appear in a guidebook (e.g. house access before area " +
    "guides). This orders the sections, not the blocks within them — for blocks inside a section use " +
    "sendsquared_guidebooks_reorder_blocks.",
  inputSchema: {
    type: "object",
    required: ["guidebookId", "order"],
    properties: {
      guidebookId: { type: "string", description: "Guidebook id" },
      order: {
        type: "array",
        description: "Block types in the order they should render",
        items: {
          type: "object",
          required: ["type", "order"],
          properties: {
            type: {
              type: "string",
              enum: ["identity", "houseGuides", "houseAccess", "areaGuides", "localGuides", "restaurantGuides", "activityGuides", "otherGuides", "legalTerms", "vehicleInfo"],
            },
            order: { type: "number", description: "Zero-based position" },
          },
        },
      },
    },
  },
  handler: async (args) => {
    const guidebookId = asString(args["guidebookId"], "guidebookId")
    const order = args["order"]
    if (!Array.isArray(order) || order.length === 0) {
      throw new Error("order must be a non-empty array")
    }
    const client = apiForRequest()
    await liveGuidebook(client, guidebookId)
    const data = await client.post(`/guidebooks/block-type-order/${encodeURIComponent(guidebookId)}`, { order })
    return envelope(data, `Block type order set for guidebook ${guidebookId}`, ["sendsquared_guidebooks_get"])
  },
}

export const guidebookBlocksSetAssets: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_set_assets",
  description:
    "Set the images attached to a guidebook block. REPLACES the block's whole asset list — assets " +
    "omitted here are detached.",
  inputSchema: {
    type: "object",
    required: ["blockId", "assetIds"],
    properties: {
      blockId: { type: "string", description: "Guidebook block id" },
      assetIds: {
        type: "array",
        items: { type: "number" },
        description: "Complete list of asset ids to attach, in display order",
      },
    },
  },
  handler: async (args) => {
    const blockId = asString(args["blockId"], "blockId")
    const assetIds = args["assetIds"]
    if (!Array.isArray(assetIds)) {
      throw new Error("assetIds must be an array of numbers")
    }
    const data = await apiForRequest().put(`/guidebooks/block-assets/${encodeURIComponent(blockId)}`, {
      assets: assetIds.map((id) => ({ id: Number(id) })),
    })
    return envelope(data, `${assetIds.length} assets set on block ${blockId}`, ["sendsquared_guidebook_blocks_get"])
  },
}

export const guidebookBlocksSetAssetThumbnail: ToolDefinition = {
  name: "sendsquared_guidebook_blocks_set_asset_thumbnail",
  description: "Set the thumbnail display width for one asset on a guidebook block.",
  inputSchema: {
    type: "object",
    required: ["blockId", "assetId", "thumbnailWidth"],
    properties: {
      blockId: { type: "string", description: "Guidebook block id" },
      assetId: { type: "number", description: "Asset id already attached to the block" },
      thumbnailWidth: { type: "number", description: "Thumbnail width in pixels" },
    },
  },
  handler: async (args) => {
    const blockId = asString(args["blockId"], "blockId")
    const data = await apiForRequest().put(`/guidebooks/block-asset-thumbnail/${encodeURIComponent(blockId)}`, {
      asset_id: asOptNumber(args["assetId"]),
      thumbnail_width: asOptNumber(args["thumbnailWidth"]),
    })
    return envelope(data, `Thumbnail width set on block ${blockId}`, ["sendsquared_guidebook_blocks_get"])
  },
}

export const placesSearch: ToolDefinition = {
  name: "sendsquared_places_search",
  description:
    "Search Google Places by name or address and get back matching predictions with their place_id. " +
    "This is the first half of the flow the guidebook UI's location picker uses: search here, pick the " +
    "right result, then pass its place_id as google_places_id to sendsquared_guidebook_blocks_create or " +
    "_update, which auto-fills coordinates, map link, location name, phone, and address from it. " +
    "Without a place_id a guidebook block has no map pin, because the API stores map data but never " +
    "derives it from a plain address.",
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "Business name and/or address, e.g. 'Thrasher's French Fries Ocean City MD'" },
    },
  },
  handler: async (args) => {
    const query = asString(args["query"], "query")
    const data = await apiForRequest().get(`/google/places/${encodeURIComponent(query)}`)
    return envelope(data, `Place predictions for "${query}"`, [
      "sendsquared_places_detail",
      "sendsquared_guidebook_blocks_create",
    ])
  },
}

export const placesDetail: ToolDefinition = {
  name: "sendsquared_places_detail",
  description:
    "Get full Google Places detail for a place_id — coordinates, formatted phone, website, map URL, " +
    "address components, and editorial summary. Use to inspect a result before creating a block; " +
    "creating or updating a block with google_places_id set does this lookup and field mapping for you.",
  inputSchema: {
    type: "object",
    required: ["place_id"],
    properties: {
      place_id: { type: "string", description: "Google place_id from sendsquared_places_search" },
    },
  },
  handler: async (args) => {
    const placeId = asString(args["place_id"], "place_id")
    const data = await apiForRequest().get(`/google/place-detail/${encodeURIComponent(placeId)}`)
    return envelope(data, `Place detail for ${placeId}`, ["sendsquared_guidebook_blocks_create"])
  },
}

/*
  Guidebook analytics live on the reports controller, not under /guidebooks.
  Every runner takes the same body — filterDates as a [start, end] pair, an
  IANA timezone, and an optional guidebook_id (0 or absent means all) — and the
  path's reportId is 0 for the generic report the SPA also uses. The tools are
  named under sendsquared_reports_ so the annotation rules mark them read-only.
*/
const GUIDEBOOK_REPORTS = ["guidebook_analytics", "guidebook_load_detail", "guidebook_saturation", "guidebook_signed", "guidebook_vehicles"]

const REPORT_PARAM_SCHEMA: Record<string, unknown> = {
  from: { type: "string", description: "Start date, YYYY-MM-DD" },
  to: { type: "string", description: "End date, YYYY-MM-DD (inclusive)" },
  timezone: { type: "string", description: "IANA timezone for day bucketing. Defaults to America/New_York." },
  guidebook_id: { type: "number", description: "Restrict to one guidebook. Omit for all guidebooks." },
}

export function guidebookReportBody(args: Record<string, unknown>): Record<string, unknown> {
  const from = asString(args["from"], "from")
  const to = asString(args["to"], "to")
  const body: Record<string, unknown> = {
    filterDates: [from, to],
    timezone: asOptString(args["timezone"]) ?? "America/New_York",
  }
  const guidebookId = asOptNumber(args["guidebook_id"])
  if (guidebookId !== undefined && guidebookId > 0) body["guidebook_id"] = guidebookId
  return body
}

export const reportsGuidebookOverview: ToolDefinition = {
  name: "sendsquared_reports_guidebook_overview",
  description:
    "Headline guidebook engagement numbers for a date range: loads, unique guests, signed legal terms, " +
    "vehicle registrations, and per-day trend. sendsquared_reports_guidebook has the per-report detail.",
  inputSchema: { type: "object", required: ["from", "to"], properties: REPORT_PARAM_SCHEMA },
  handler: async (args) => {
    const data = await apiForRequest().post("/reports/guidebook-analytics/overview", guidebookReportBody(args))
    return envelope(data, "Guidebook analytics overview", ["sendsquared_reports_guidebook", "sendsquared_guidebooks_list"])
  },
}

export const reportsGuidebook: ToolDefinition = {
  name: "sendsquared_reports_guidebook",
  description:
    "Run one of the guidebook reports over a date range. " +
    "guidebook_analytics: one row per guidebook with load and engagement totals. " +
    "guidebook_load_detail: which contact loaded which guidebook, by day. " +
    "guidebook_saturation: reservations vs. reservations that opened the guidebook, as a percentage. " +
    "guidebook_signed: legal-terms acceptances per guidebook. " +
    "guidebook_vehicles: vehicle registrations collected through vehicleInfo blocks.",
  inputSchema: {
    type: "object",
    required: ["report", "from", "to"],
    properties: {
      report: { type: "string", enum: GUIDEBOOK_REPORTS, description: "Which report to run" },
      ...REPORT_PARAM_SCHEMA,
    },
  },
  handler: async (args) => {
    const report = asString(args["report"], "report")
    if (!GUIDEBOOK_REPORTS.includes(report)) {
      throw new Error(`report must be one of: ${GUIDEBOOK_REPORTS.join(", ")}`)
    }
    const data = await apiForRequest().post(`/reports/run/${report}/0`, guidebookReportBody(args))
    return envelope(data, `Guidebook report: ${report}`, ["sendsquared_reports_guidebook_overview", "sendsquared_guidebooks_get"])
  },
}

/*
  What a guest did inside a guidebook is stored against the contact, not the
  guidebook — the SPA shows it on the contact's verification card. Loads are
  open to any authenticated user; legal acceptances and vehicles require the
  VerificationView ACL and the API answers 403 without it.
*/
export const contactsGuidebookLoadsList: ToolDefinition = {
  name: "sendsquared_contacts_guidebook_loads_list",
  description: "Guidebook load history for a contact: which guidebook they opened, how many times, on which days.",
  inputSchema: {
    type: "object",
    required: ["contactId"],
    properties: {
      contactId: { type: "string" },
      timezone: { type: "string", description: "IANA timezone for day bucketing. Defaults to America/New_York." },
    },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const data = await apiForRequest().get(`/contacts/${encodeURIComponent(contactId)}/guidebook-loads`, {
      timezone: asOptString(args["timezone"]),
    })
    return envelope(data, `Guidebook loads for contact ${contactId}`, ["sendsquared_contacts_get", "sendsquared_contacts_legal_acceptances_list"])
  },
}

export const contactsLegalAcceptancesList: ToolDefinition = {
  name: "sendsquared_contacts_legal_acceptances_list",
  description:
    "Legal-terms acceptances a contact has signed through guidebook legalTerms blocks, with the block, reservation, " +
    "signature details and any party members collected. Requires the verification-view permission.",
  inputSchema: { type: "object", required: ["contactId"], properties: { contactId: { type: "string" } } },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const data = await apiForRequest().get(`/contacts/${encodeURIComponent(contactId)}/legal-acceptances`)
    return envelope(data, `Legal acceptances for contact ${contactId}`, ["sendsquared_contacts_legal_acceptance_party_members_set", "sendsquared_contacts_vehicles_list"])
  },
}

export const contactsLegalAcceptancePartyMembersSet: ToolDefinition = {
  name: "sendsquared_contacts_legal_acceptance_party_members_set",
  description:
    "Replace the party-member names recorded on one legal acceptance. This REPLACES the whole list — names you " +
    "omit are removed. sendsquared_contacts_legal_acceptances_list returns the current list.",
  inputSchema: {
    type: "object",
    required: ["contactId", "acceptanceId", "party_members"],
    properties: {
      contactId: { type: "string" },
      acceptanceId: { type: "string" },
      party_members: { type: "array", items: { type: "string" }, description: "Full list of party member names" },
    },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const acceptanceId = asString(args["acceptanceId"], "acceptanceId")
    const members = args["party_members"]
    if (!Array.isArray(members)) throw new Error("party_members must be an array of strings")
    const data = await apiForRequest().put(
      `/contacts/${encodeURIComponent(contactId)}/legal-acceptances/${encodeURIComponent(acceptanceId)}/party-members`,
      { party_members: members.map(String) },
    )
    return envelope(data, `Party members set on acceptance ${acceptanceId}`, ["sendsquared_contacts_legal_acceptances_list"])
  },
}

export const contactsVehiclesList: ToolDefinition = {
  name: "sendsquared_contacts_vehicles_list",
  description: "Vehicles a contact registered through guidebook vehicleInfo blocks, grouped by reservation. Requires the verification-view permission.",
  inputSchema: { type: "object", required: ["contactId"], properties: { contactId: { type: "string" } } },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const data = await apiForRequest().get(`/contacts/${encodeURIComponent(contactId)}/vehicles`)
    return envelope(data, `Vehicles for contact ${contactId}`, ["sendsquared_contacts_vehicles_set"])
  },
}

export const contactsVehiclesSet: ToolDefinition = {
  name: "sendsquared_contacts_vehicles_set",
  description:
    "Replace the vehicles registered for a contact on one reservation and vehicleInfo block. This REPLACES the " +
    "set for that reservation/block pair — vehicles you omit are removed. " +
    "sendsquared_contacts_vehicles_list returns the current list.",
  inputSchema: {
    type: "object",
    required: ["contactId", "reservation_id", "guidebook_block_id", "vehicles"],
    properties: {
      contactId: { type: "string" },
      reservation_id: { type: "number" },
      guidebook_block_id: { type: "number", description: "The vehicleInfo block the registration belongs to" },
      vehicles: {
        type: "array",
        items: {
          type: "object",
          required: ["license_plate"],
          properties: {
            license_plate: { type: "string" },
            make: { type: "string" },
            model: { type: "string" },
          },
        },
      },
    },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const vehicles = args["vehicles"]
    if (!Array.isArray(vehicles)) throw new Error("vehicles must be an array")
    const data = await apiForRequest().put(`/contacts/${encodeURIComponent(contactId)}/vehicles`, {
      reservation_id: asNumber(args["reservation_id"], "reservation_id"),
      guidebook_block_id: asNumber(args["guidebook_block_id"], "guidebook_block_id"),
      vehicles,
    })
    return envelope(data, `${vehicles.length} vehicles set for contact ${contactId}`, ["sendsquared_contacts_vehicles_list"])
  },
}

export const guidebooksTools: ToolDefinition[] = [
  guidebooksList,
  guidebooksGet,
  guidebooksCreate,
  guidebooksUpdate,
  guidebooksDuplicate,
  guidebooksDelete,
  guidebooksAssignUnits,
  guidebooksUnassignUnits,
  guidebooksBlockTypes,
  guidebookBlocksList,
  guidebookBlocksGet,
  guidebookBlocksCreate,
  guidebookBlocksUpdate,
  guidebookBlocksDelete,
  guidebooksAddBlocks,
  guidebooksRemoveBlocks,
  guidebooksReorderBlocks,
  guidebookBlocksCreateBatch,
  guidebookThemesList,
  guidebookThemesGet,
  guidebookThemesCreate,
  guidebookThemesUpdate,
  guidebookThemesDelete,
  guidebooksConditionsGet,
  guidebooksConditionsSet,
  guidebookBlocksConditionsGet,
  guidebookBlocksConditionsSet,
  guidebookBlocksGuidebooksGet,
  guidebookBlocksGuidebooksSet,
  guidebooksUnitAssignments,
  guidebooksSetBlockTypeOrder,
  guidebookBlocksSetAssets,
  guidebookBlocksSetAssetThumbnail,
  placesSearch,
  placesDetail,
  reportsGuidebookOverview,
  reportsGuidebook,
  contactsGuidebookLoadsList,
  contactsLegalAcceptancesList,
  contactsLegalAcceptancePartyMembersSet,
  contactsVehiclesList,
  contactsVehiclesSet,
]
