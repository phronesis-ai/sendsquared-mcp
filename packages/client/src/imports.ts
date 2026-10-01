export enum ImportGroupMode {
  New = 1,
  Existing = 2,
}

export const IMPORT_SKIP_COLUMN = "skip"
export const IMPORT_CUSTOM_FIELD_PREFIX = "custom_field."

export const IMPORT_STANDARD_COLUMNS = [
  "company_name",
  "first_name",
  "last_name",
  "email",
  "mobile_phone",
  "home_phone",
  "address_1",
  "address_2",
  "locality",
  "region",
  "postal",
  "country",
  "locale",
  "timezone",
]

export const IMPORT_SPECIAL_COLUMNS = ["special.name_parser", "special.dynamic_tags", "special.dynamic_groups"]

export interface ImportUploadResult {
  storedFiledName: string
  headerLines: string[][]
  fileSize?: number
  numberLines?: number
  error?: unknown
}

export interface ImportStartOptions {
  storedFileName: string
  columns: string[]
  newGroupName?: string
  groupId?: number
  duplicateAddGroups: boolean
  duplicateAddTags: boolean
  duplicateUpdate: boolean
}

/*
  Mirrors the SPA's column dropdown. The job treats the first CSV row as a
  header and never imports it, and it applies each mapped column by position,
  so a mapping must name exactly one target per CSV column. Only `skip` and
  the special columns may repeat; a repeated standard field would silently
  keep just the last value.
*/
export function validateImportColumns(columns: string[], customFieldNames: string[], csvColumnCount?: number): string[] {
  const errors: string[] = []
  if (csvColumnCount !== undefined && columns.length !== csvColumnCount) {
    errors.push(`the file has ${csvColumnCount} columns but ${columns.length} were mapped`)
  }
  const custom = new Set(customFieldNames)
  const seen = new Set<string>()
  columns.forEach((column, index) => {
    const position = `column ${index + 1} (${column || "empty"})`
    switch (true) {
      case column === IMPORT_SKIP_COLUMN:
        return
      case IMPORT_SPECIAL_COLUMNS.includes(column):
        break
      case IMPORT_STANDARD_COLUMNS.includes(column):
        if (seen.has(column)) {
          errors.push(`${position} is mapped more than once`)
        }
        break
      case column.startsWith(IMPORT_CUSTOM_FIELD_PREFIX):
        if (!custom.has(column.slice(IMPORT_CUSTOM_FIELD_PREFIX.length))) {
          errors.push(`${position} is not a contact custom field`)
        }
        if (seen.has(column)) {
          errors.push(`${position} is mapped more than once`)
        }
        break
      default:
        errors.push(`${position} is not a known column`)
    }
    seen.add(column)
  })
  if (!columns.includes("email")) {
    errors.push("one column must be mapped to email; rows without a valid email are not imported")
  }
  return errors
}

const HEADER_SYNONYMS: Record<string, string> = {
  email: "email",
  e_mail: "email",
  email_address: "email",
  first_name: "first_name",
  first: "first_name",
  firstname: "first_name",
  given_name: "first_name",
  last_name: "last_name",
  last: "last_name",
  lastname: "last_name",
  surname: "last_name",
  name: "special.name_parser",
  full_name: "special.name_parser",
  phone: "mobile_phone",
  mobile: "mobile_phone",
  mobile_phone: "mobile_phone",
  cell: "mobile_phone",
  cell_phone: "mobile_phone",
  home_phone: "home_phone",
  company: "company_name",
  company_name: "company_name",
  address: "address_1",
  address_1: "address_1",
  address1: "address_1",
  street: "address_1",
  address_2: "address_2",
  address2: "address_2",
  city: "locality",
  locality: "locality",
  state: "region",
  region: "region",
  province: "region",
  zip: "postal",
  zip_code: "postal",
  zipcode: "postal",
  postal: "postal",
  postal_code: "postal",
  country: "country",
  locale: "locale",
  language: "locale",
  timezone: "timezone",
  time_zone: "timezone",
  tags: "special.dynamic_tags",
  groups: "special.dynamic_groups",
}

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

/*
  A starting mapping from the sample the upload returns: header names first,
  then contact custom fields by name, then the SPA's rule of treating a column
  whose sample values look like email addresses as email. Anything unmatched
  is `skip`, so the caller should read the suggestion before starting.
*/
export function suggestImportColumns(headerLines: string[][], customFieldNames: string[]): string[] {
  const header = headerLines[0] ?? []
  const samples = headerLines.slice(1)
  const customByNormalized = new Map(customFieldNames.map((name) => [normalizeHeader(name), name]))
  const used = new Set<string>()
  const suggestion = header.map((raw) => {
    const key = normalizeHeader(raw)
    const standard = HEADER_SYNONYMS[key]
    if (standard && !used.has(standard)) {
      used.add(standard)
      return standard
    }
    const custom = customByNormalized.get(key)
    if (custom) {
      const column = IMPORT_CUSTOM_FIELD_PREFIX + custom
      if (!used.has(column)) {
        used.add(column)
        return column
      }
    }
    return IMPORT_SKIP_COLUMN
  })
  if (!used.has("email")) {
    const emailIndex = header.findIndex(
      (_, index) => suggestion[index] === IMPORT_SKIP_COLUMN && samples.some((row) => EMAIL_LIKE.test((row[index] ?? "").trim())),
    )
    if (emailIndex >= 0) {
      suggestion[emailIndex] = "email"
    }
  }
  return suggestion
}

export function importStartBody(options: ImportStartOptions): Record<string, unknown> {
  const hasNew = options.newGroupName !== undefined && options.newGroupName.trim() !== ""
  const hasExisting = options.groupId !== undefined
  if (hasNew === hasExisting) {
    throw new Error("pass exactly one of a new group name or an existing group id")
  }
  const body: Record<string, unknown> = {
    storedFileName: options.storedFileName,
    columnSort: options.columns,
    skipTopRow: false,
    duplicateAddGroups: options.duplicateAddGroups,
    duplicateAddTags: options.duplicateAddTags,
    duplicateOverrideSource: options.duplicateUpdate,
  }
  if (hasNew) {
    body["groupMode"] = ImportGroupMode.New
    body["groupNew"] = options.newGroupName?.trim()
  } else {
    body["groupMode"] = ImportGroupMode.Existing
    body["groupExisting"] = options.groupId
  }
  return body
}

export function contactCustomFieldNames(fields: unknown): string[] {
  const rows = Array.isArray(fields) ? (fields as Array<Record<string, unknown>>) : []
  return rows.filter((f) => f["object_type"] === "contact").map((f) => String(f["field_name"]))
}
