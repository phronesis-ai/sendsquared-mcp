import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { SENDSQUARED_PLAYBOOK } from "./playbook.js"
import { STRIPO_REFERENCE } from "./stripo-reference.js"
import { MERGE_TOKENS_REFERENCE } from "./merge-tokens.js"
import { PROMPTS, PROMPT_BY_NAME } from "./prompts.js"

const PLAYBOOK_URI = "sendsquared://playbook"
const STRIPO_URI = "sendsquared://stripo-reference"
const MERGE_TOKENS_URI = "sendsquared://merge-tokens"

export function registerSkills(server: Server): void {
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: PLAYBOOK_URI,
        name: "SendSquared Playbook",
        description:
          "How to use SendSquared effectively: the segment-first principle for analytical questions, " +
          "the full segment condition model (types, operators, value types, JSON shape, worked examples), " +
          "the workflow trigger and action model, decision flowcharts for common goals, and invariants. " +
          "Read this resource at the start of any SendSquared task to understand how the platform thinks.",
        mimeType: "text/markdown",
      },
      {
        uri: STRIPO_URI,
        name: "Stripo Email Template Reference",
        description:
          "The exact HTML markup patterns required for Stripo-compatible email templates in SendSquared. " +
          "Includes the document skeleton, content section pattern, block types (text, image, button, spacer), " +
          "padding classes, footer with merge tokens, and important rules. " +
          "Read this resource BEFORE calling sendsquared_email_templates_create.",
        mimeType: "text/markdown",
      },
      {
        uri: MERGE_TOKENS_URI,
        name: "SendSquared Merge Tokens & Special URLs",
        description:
          "Authoritative catalog of the ~180 merge tokens available to email and SMS templates " +
          "(contact, company, campaign, reservation, units, lead, survey, cart_abandon namespaces) and the five " +
          "special URLs for guidebooks (ssqgo.com), surveys (sndsq.com), unsubscribe, manage preferences, and " +
          "campaign archive. Also documents engine constraints (no expressions, arrays via index, monetary " +
          "fields are in cents). Read this resource BEFORE writing any email or SMS template body.",
        mimeType: "text/markdown",
      },
    ],
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri
    if (uri === PLAYBOOK_URI) {
      return {
        contents: [{ uri: PLAYBOOK_URI, mimeType: "text/markdown", text: SENDSQUARED_PLAYBOOK }],
      }
    }
    if (uri === STRIPO_URI) {
      return {
        contents: [{ uri: STRIPO_URI, mimeType: "text/markdown", text: STRIPO_REFERENCE }],
      }
    }
    if (uri === MERGE_TOKENS_URI) {
      return {
        contents: [{ uri: MERGE_TOKENS_URI, mimeType: "text/markdown", text: MERGE_TOKENS_REFERENCE }],
      }
    }
    throw new Error(`Unknown resource URI: ${uri}`)
  })

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: PROMPTS.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments,
    })),
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name
    const prompt = PROMPT_BY_NAME.get(name)
    if (!prompt) {
      throw new Error(`Unknown prompt: ${name}`)
    }
    const args = (request.params.arguments ?? {}) as Record<string, string>
    return {
      description: prompt.description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: prompt.render(args),
          },
        },
      ],
    }
  })
}
