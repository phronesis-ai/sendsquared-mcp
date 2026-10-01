import { apiForRequest, envelope, asString, asOptString, asOptNumber, asNumber } from "./shared.js"
import type { ToolDefinition } from "./types.js"

/*
  Folders are a flat table keyed by folder_type with an optional parent_id.
  The API's folder_type values are fixed strings; "templates-email" is what
  the email template picker uses, so it is the default everywhere here.
  The API's FolderType enum lists "autumations" for workflows, but the web
  app writes and reads "automations" and that is what the data holds, so we
  follow the web app.
*/
export const FOLDER_TYPES = [
  "templates-email",
  "templates-sms",
  "templates-postcard",
  "automations",
  "group",
  "popup",
] as const

export interface FolderRecord {
  id: number
  folder_name: string
  folder_type: string
  parent_id: number | null
  [key: string]: unknown
}

/*
  Attaches a human-readable path ("MAINE / Maine_Guest") to every folder so a
  nested layout is legible in a flat list, and sorts by that path.
*/
export function withFolderPaths(folders: FolderRecord[]): Array<FolderRecord & { path: string }> {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const pathOf = (f: FolderRecord, seen = new Set<number>()): string => {
    seen.add(f.id)
    if (f.parent_id == null || seen.has(f.parent_id)) return f.folder_name
    const parent = byId.get(f.parent_id)
    if (!parent) return f.folder_name
    return `${pathOf(parent, seen)} / ${f.folder_name}`
  }
  return folders
    .map((f) => ({ ...f, path: pathOf(f) }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

export const foldersList: ToolDefinition = {
  name: "sendsquared_folders_list",
  description:
    "List folders for organizing email templates, groups/segments (folder_type 'group'), automations or popups. Returns each folder with its id, parent_id, and a full 'path' like 'MAINE / Maine_Guest'. Use with sendsquared_email_templates_list or sendsquared_groups_list (folder_id) to see what is in each folder.",
  inputSchema: {
    type: "object",
    properties: {
      folder_type: {
        type: "string",
        enum: [...FOLDER_TYPES],
        default: "templates-email",
        description: "Which kind of folder to list. Defaults to email template folders.",
      },
    },
  },
  handler: async (args) => {
    const folderType = asOptString(args["folder_type"]) ?? "templates-email"
    const raw = (await apiForRequest().get("/folders", { type: folderType })) as FolderRecord[]
    const folders = withFolderPaths(Array.isArray(raw) ? raw : [])
    return envelope({ folders, total: folders.length, folder_type: folderType }, `${folders.length} ${folderType} folders`, [
      "sendsquared_email_templates_list",
      "sendsquared_groups_list",
      "sendsquared_folders_create",
      "sendsquared_email_templates_set_folder",
      "sendsquared_groups_set_folder",
    ])
  },
}

export const foldersCreate: ToolDefinition = {
  name: "sendsquared_folders_create",
  description:
    "Create a folder. Pass parent_id to nest it under an existing folder. Defaults to an email template folder.",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string", description: "Folder name" },
      folder_type: { type: "string", enum: [...FOLDER_TYPES], default: "templates-email" },
      parent_id: { type: "number", description: "Parent folder id for a nested folder" },
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const folderType = asOptString(args["folder_type"]) ?? "templates-email"
    const parentId = asOptNumber(args["parent_id"])
    const body: Record<string, unknown> = { folder_name: name, folder_type: folderType }
    if (parentId !== undefined) body["parent_id"] = parentId
    const data = await apiForRequest().post("/folders", body)
    return envelope(data, `Folder "${name}" created`, [
      "sendsquared_email_templates_set_folder",
      "sendsquared_folders_list",
    ])
  },
}

export const foldersRename: ToolDefinition = {
  name: "sendsquared_folders_rename",
  description: "Rename a folder. Only the name can change; to re-parent a folder, create a new one and move the templates.",
  inputSchema: {
    type: "object",
    required: ["id", "name"],
    properties: {
      id: { type: "number", description: "Folder id" },
      name: { type: "string", description: "New folder name" },
    },
  },
  handler: async (args) => {
    const id = asNumber(args["id"], "id")
    const name = asString(args["name"], "name")
    await apiForRequest().put(`/folders/${id}`, { folder_name: name })
    return envelope({ id, folder_name: name }, `Folder ${id} renamed to "${name}"`, ["sendsquared_folders_list"])
  },
}

export const foldersDelete: ToolDefinition = {
  name: "sendsquared_folders_delete",
  description:
    "Delete a folder. Templates inside it are NOT deleted — they are unfiled and remain available. Child folders are not removed; move or delete them first if you want a clean tree.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "number", description: "Folder id" },
    },
  },
  handler: async (args) => {
    const id = asNumber(args["id"], "id")
    await apiForRequest().delete(`/folders/${id}`)
    return envelope(null, `Folder ${id} deleted (its templates are now unfiled)`, ["sendsquared_folders_list"])
  },
}

export const foldersTools: ToolDefinition[] = [foldersList, foldersCreate, foldersRename, foldersDelete]
