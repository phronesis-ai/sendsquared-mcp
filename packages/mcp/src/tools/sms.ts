import { apiForRequest, envelope, asString, asOptString } from "./shared.js"
import type { ToolDefinition } from "./types.js"

export const smsSend: ToolDefinition = {
  name: "sendsquared_sms_send",
  description: "Send a single SMS message to a SendSquared contact. High-impact — confirm with the user first, especially if the message will go to multiple recipients via a campaign.",
  inputSchema: {
    type: "object",
    required: ["contactId", "message"],
    properties: {
      contactId: { type: "string", description: "Recipient contact id" },
      message: { type: "string", description: "Plain-text message body" },
      fromPhoneNumberId: {
        type: "string",
        description: "Optional: phone number id to send from. Uses the account default if omitted.",
      },
    },
  },
  handler: async (args) => {
    const contactId = asString(args["contactId"], "contactId")
    const message = asString(args["message"], "message")
    const data = await apiForRequest().post("/sms", {
      contactId,
      message,
      phoneNumberId: asOptString(args["fromPhoneNumberId"]),
    })
    return envelope(data, `SMS sent to contact ${contactId}`, [
      "sendsquared_contacts_get",
      "sendsquared_sms_list",
    ])
  },
}

export const smsList: ToolDefinition = {
  name: "sendsquared_sms_list",
  description: "List SMS messages for this company, optionally filtered to a single contact.",
  inputSchema: {
    type: "object",
    properties: {
      contactId: { type: "string", description: "Restrict to messages involving this contact" },
    },
  },
  handler: async (args) => {
    const contactId = asOptString(args["contactId"])
    const result = await apiForRequest().list("/sms", { contactId })
    return envelope(
      { messages: result.data, total: result.total },
      `${result.total} SMS messages`,
      ["sendsquared_sms_send"],
    )
  },
}

export const smsTools: ToolDefinition[] = [smsSend, smsList]
