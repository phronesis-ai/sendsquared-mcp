import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"

export interface ToolInputSchema {
  type: "object"
  required?: string[]
  properties?: Record<string, unknown>
}

export type ToolResult = CallToolResult

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  handler: (args: Record<string, unknown>) => Promise<ToolResult>
  annotations?: ToolAnnotations
}
