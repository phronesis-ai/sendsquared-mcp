import { apiForRequest, envelope, asString, asNumber, asOptString } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const notesList: ToolDefinition = {
  name: "sendsquared_notes_list",
  description:
    "List notes attached to a lead or contact. Notes track follow-up activities, call logs, " +
    "internal comments, and interaction history. Use source='lead' for lead notes, source='contact' for contact notes.",
  inputSchema: {
    type: "object",
    required: ["source", "sourceId"],
    properties: {
      source: { type: "string", enum: ["lead", "contact"], description: "Note source type" },
      sourceId: { type: "string", description: "The lead id or contact id" },
    },
  },
  handler: async (args) => {
    const source = asString(args["source"], "source")
    const sourceId = asString(args["sourceId"], "sourceId")
    const data = await apiForRequest().get(`/notes/${source}/${encodeURIComponent(sourceId)}`)
    return envelope(data, `Notes for ${source} ${sourceId}`, [
      "sendsquared_notes_create",
    ])
  },
}

export const notesCreate: ToolDefinition = {
  name: "sendsquared_notes_create",
  description:
    "Create a note on a lead or contact. Use for logging follow-up calls, meeting notes, " +
    "internal comments, or any interaction history.",
  inputSchema: {
    type: "object",
    required: ["source", "source_id", "note"],
    properties: {
      source: { type: "string", enum: ["lead", "contact"], description: "Attach to a lead or contact" },
      source_id: { type: "number", description: "The lead id or contact id" },
      note: { type: "string", description: "The note content (supports plain text)" },
    },
  },
  /*
    The tool's own schema keeps source/source_id/note because that is what the
    docs and existing prompts use, but POST /notes does not accept those names.
    It wants source_type/source_type_id/notes, and rejects anything else with a
    422 that lists the three expected fields. Reported by Fred 2026-08-20; every
    programmatic note create was failing. The id is also coerced to a number —
    the schema advertises one but the old handler forwarded whatever arrived,
    so a quoted "123" from the model went to the API as a string.
  */
  handler: async (args) => {
    const source = asString(args["source"], "source")
    const sourceId = asNumber(args["source_id"], "source_id")
    const note = asString(args["note"], "note")
    const data = await apiForRequest().post("/notes", {
      source_type: source,
      source_type_id: sourceId,
      notes: note,
    })
    return envelope(data, `Note added to ${source} ${sourceId}`, [
      "sendsquared_notes_list",
    ])
  },
}

export const notesUpdate: ToolDefinition = {
  name: "sendsquared_notes_update",
  description: "Update an existing note's content.",
  inputSchema: {
    type: "object",
    required: ["id", "note"],
    properties: {
      id: { type: "string", description: "Note id" },
      note: { type: "string", description: "Updated note content" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const note = asString(args["note"], "note")
    /*
      Same field mismatch as create: UpdateNoteInputModel is { notes }, and the
      controller rejects the request outright when notes is absent. Sending
      { note } meant every update failed, which nobody reported only because
      updates are rarer than creates.
    */
    const data = await apiForRequest().put(`/notes/${encodeURIComponent(id)}`, { notes: note })
    return envelope(data, `Note ${id} updated`, [])
  },
}

export const notesDelete: ToolDefinition = {
  name: "sendsquared_notes_delete",
  description: "Delete a note. Destructive — confirm with the user first.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    await apiForRequest().delete(`/notes/${encodeURIComponent(id)}`)
    return envelope(null, `Note ${id} deleted`, [])
  },
}

export const notesTools: ToolDefinition[] = [notesList, notesCreate, notesUpdate, notesDelete]
