import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { contactsTools } from "./tools/contacts.js"
import { campaignsTools } from "./tools/campaigns.js"
import { leadsTools } from "./tools/leads.js"
import { tagsTools } from "./tools/tags.js"
import { brandsTools } from "./tools/brands.js"
import { taxonomyTools } from "./tools/taxonomy.js"
import { connectorMapsTools } from "./tools/connectorMaps.js"
import { callsTools } from "./tools/calls.js"
import { groupsTools } from "./tools/groups.js"
import { workflowsTools } from "./tools/workflows.js"
import { templatesTools } from "./tools/templates.js"
import { foldersTools } from "./tools/folders.js"
import { smsTools } from "./tools/sms.js"
import { reportsTools } from "./tools/reports.js"
import { webhooksTools } from "./tools/webhooks.js"
import { reservationsTools } from "./tools/reservations.js"
import { guidebooksTools } from "./tools/guidebooks.js"
import { tasksTools } from "./tools/tasks.js"
import { notesTools } from "./tools/notes.js"
import { staffingTools } from "./tools/staffing.js"
import { surveysTools } from "./tools/surveys.js"
import { importsTools } from "./tools/imports.js"
import { metaTools } from "./tools/meta.js"
import { registerSkills } from "./skills/register.js"
import { deriveAnnotations } from "./tools/annotations.js"
import type { ToolDefinition } from "./tools/types.js"

const ALL_TOOLS: ToolDefinition[] = [
  ...contactsTools,
  ...campaignsTools,
  ...leadsTools,
  ...tagsTools,
  ...brandsTools,
  ...taxonomyTools,
  ...connectorMapsTools,
  ...callsTools,
  ...groupsTools,
  ...workflowsTools,
  ...templatesTools,
  ...foldersTools,
  ...smsTools,
  ...reportsTools,
  ...webhooksTools,
  ...reservationsTools,
  ...guidebooksTools,
  ...tasksTools,
  ...notesTools,
  ...staffingTools,
  ...surveysTools,
  ...importsTools,
  ...metaTools,
]

const TOOL_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]))

export function buildMcpServer(): Server {
  const server = new Server(
    { name: "sendsquared", version: "0.2.20" },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  registerSkills(server)

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: t.annotations ?? deriveAnnotations(t.name),
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    const tool = TOOL_BY_NAME.get(name)
    if (!tool) {
      console.log(`[tool] UNKNOWN tool="${name}"`)
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }) }],
        isError: true,
      }
    }

    const args = (rawArgs ?? {}) as Record<string, unknown>
    const result = await tool.handler(args).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const argKeys = Object.keys(args).join(",")
      console.log(`[tool] ERROR tool="${name}" args=[${argKeys}] error="${message.slice(0, 200)}"`)
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: false, error: message }),
          },
        ],
        isError: true,
      }
    })

    return result
  })

  return server
}

export function listAllToolNames(): string[] {
  return ALL_TOOLS.map((t) => t.name)
}
