import {
  IMPORT_SKIP_COLUMN,
  IMPORT_STANDARD_COLUMNS,
  IMPORT_SPECIAL_COLUMNS,
  IMPORT_CUSTOM_FIELD_PREFIX,
  validateImportColumns,
  suggestImportColumns,
  importStartBody,
  contactCustomFieldNames,
  type ImportUploadResult,
} from "@sendsquared/client"
import { apiForRequest, envelope, asString, asOptString, asOptNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

const MAX_CSV_BYTES = 10 * 1024 * 1024

async function customFieldNames(): Promise<string[]> {
  return contactCustomFieldNames(await apiForRequest().get("/custom-fields/"))
}

function optBool(value: unknown, name: string): boolean {
  if (value === undefined) {
    return false
  }
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be true or false`)
  }
  return value
}

export const importsColumns: ToolDefinition = {
  name: "sendsquared_imports_columns",
  description:
    "List the column targets a contact import accepts, including this company's contact custom fields. " +
    "special.name_parser splits a full name into first/last; special.dynamic_tags and special.dynamic_groups " +
    "take comma-separated names and create any that are missing.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const custom = (await customFieldNames()).map((name) => IMPORT_CUSTOM_FIELD_PREFIX + name)
    return envelope(
      { skip: IMPORT_SKIP_COLUMN, standard: IMPORT_STANDARD_COLUMNS, special: IMPORT_SPECIAL_COLUMNS, custom_fields: custom },
      "Import column targets",
      ["sendsquared_imports_upload"],
    )
  },
}

export const importsUpload: ToolDefinition = {
  name: "sendsquared_imports_upload",
  description:
    "Upload CSV text for a contact import. Nothing is imported yet: this returns a stored_file_name, the first " +
    "few rows, and a suggested column mapping. Review the mapping with the user (unmatched columns are 'skip'), " +
    "then call sendsquared_imports_start. The first CSV row is treated as a header and is never imported.",
  inputSchema: {
    type: "object",
    required: ["csv"],
    properties: {
      csv: { type: "string", description: "Full CSV file contents, header row first (max 10 MB)" },
      file_name: { type: "string", description: "Original file name, for reference" },
    },
  },
  handler: async (args) => {
    const csv = asString(args["csv"], "csv")
    if (Buffer.byteLength(csv, "utf8") > MAX_CSV_BYTES) {
      throw new Error("csv is larger than 10 MB; use the CLI (`sendsquared imports run <file>`) for big files")
    }
    const fileName = asOptString(args["file_name"]) ?? "import.csv"
    const form = new FormData()
    form.append("importFile", new Blob([csv], { type: "text/csv" }), fileName)
    const result = await apiForRequest().postForm<ImportUploadResult>("/imports", form)
    if (result.error) {
      throw new Error(`upload failed: ${JSON.stringify(result.error)}`)
    }
    const suggested = suggestImportColumns(result.headerLines, await customFieldNames())
    return envelope(
      {
        stored_file_name: result.storedFiledName,
        file_size: result.fileSize ?? null,
        sample: result.headerLines,
        suggested_columns: suggested,
      },
      `Uploaded ${fileName}; confirm suggested_columns before starting`,
      ["sendsquared_imports_start", "sendsquared_imports_columns"],
    )
  },
}

export const importsStart: ToolDefinition = {
  name: "sendsquared_imports_start",
  description:
    "Start a contact import from a file uploaded with sendsquared_imports_upload. Pass one column target per CSV " +
    "column in order, and exactly one of new_group_name or group_id; every imported contact is added to that group. " +
    "Contacts that already exist are counted as duplicates and left alone unless the duplicate_* flags say " +
    "otherwise. Confirm the mapping and flags with the user first — the import cannot be undone.",
  inputSchema: {
    type: "object",
    required: ["stored_file_name", "columns"],
    properties: {
      stored_file_name: { type: "string" },
      columns: { type: "array", items: { type: "string" }, description: "Target per CSV column, e.g. [\"email\",\"first_name\",\"skip\"]" },
      new_group_name: { type: "string", description: "Create a group with this name" },
      group_id: { type: "number", description: "Use this existing group" },
      duplicate_add_groups: { type: "boolean", description: "Add existing contacts to the import group(s). Default false." },
      duplicate_add_tags: { type: "boolean", description: "Add special.dynamic_tags tags to existing contacts. Default false." },
      duplicate_update: {
        type: "boolean",
        description: "Update existing contacts from this file (names, address, locale, timezone, company, custom fields); blank cells keep stored values. Default false.",
      },
    },
  },
  handler: async (args) => {
    const storedFileName = asString(args["stored_file_name"], "stored_file_name")
    const columns = args["columns"]
    if (!Array.isArray(columns) || columns.some((c) => typeof c !== "string")) {
      throw new Error("columns must be an array of strings")
    }
    const errors = validateImportColumns(columns as string[], await customFieldNames())
    if (errors.length > 0) {
      throw new Error(`column mapping: ${errors.join("; ")}`)
    }
    const body = importStartBody({
      storedFileName,
      columns: columns as string[],
      newGroupName: asOptString(args["new_group_name"]),
      groupId: asOptNumber(args["group_id"]),
      duplicateAddGroups: optBool(args["duplicate_add_groups"], "duplicate_add_groups"),
      duplicateAddTags: optBool(args["duplicate_add_tags"], "duplicate_add_tags"),
      duplicateUpdate: optBool(args["duplicate_update"], "duplicate_update"),
    })
    const client = apiForRequest()
    await client.post("/imports/complete", body)
    const rows = ((await client.get("/imports")) ?? []) as Array<Record<string, unknown>>
    const created = rows.find((r) => r["s3_file"] === storedFileName) ?? null
    return envelope({ import: created, stored_file_name: storedFileName }, `Import queued for ${storedFileName}`, [
      "sendsquared_imports_list",
      "sendsquared_imports_get",
    ])
  },
}

export const importsList: ToolDefinition = {
  name: "sendsquared_imports_list",
  description: "List contact imports for this company, newest first, with status and counts.",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "number", default: 10 } },
  },
  handler: async (args) => {
    const limit = asOptNumber(args["limit"]) ?? 10
    const rows = ((await apiForRequest().get("/imports")) ?? []) as Array<Record<string, unknown>>
    const sorted = [...rows].sort((a, b) => parseInt(String(b["id"]), 10) - parseInt(String(a["id"]), 10))
    return envelope({ imports: sorted.slice(0, limit), total: rows.length }, `${rows.length} imports`, ["sendsquared_imports_get"])
  },
}

export const importsGet: ToolDefinition = {
  name: "sendsquared_imports_get",
  description: "Get one contact import's status and counts.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "number" } },
  },
  handler: async (args) => {
    const id = asOptNumber(args["id"])
    const rows = ((await apiForRequest().get("/imports")) ?? []) as Array<Record<string, unknown>>
    const row = rows.find((r) => parseInt(String(r["id"]), 10) === id)
    if (!row) {
      throw new Error(`Import ${String(args["id"])} not found`)
    }
    return envelope(row, `Import ${String(id)}: ${String(row["status"] ?? row["imported"] ?? "unknown")}`)
  },
}

export const importsTools: ToolDefinition[] = [importsColumns, importsUpload, importsStart, importsList, importsGet]
