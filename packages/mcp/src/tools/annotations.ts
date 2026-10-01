import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js"

/*
  MCP Connector Directory requires every tool to expose `title` plus
  `readOnlyHint` or `destructiveHint`. We derive these from the tool name so
  we don't have to maintain ~125 hand-written annotations. A tool can still
  override by setting `annotations` on its ToolDefinition.

  Classification:
    - read-only: lists, gets, searches, reports, type/format introspection,
      and the doctor/version meta tools.
    - destructive: anything that deletes, merges contacts, fires a send
      (email/SMS/workflow run), since those effects are irreversible.
    - everything else: mutating but non-destructive (creates, updates,
      duplicates, archive/unarchive, add/remove association tools).

  All tools touch the SendSquared API, so openWorldHint is true everywhere.
*/

const READ_ONLY_EXACT = new Set([
  "sendsquared_doctor",
  "sendsquared_version",
])

const READ_ONLY_PATTERNS: RegExp[] = [
  /_list$/,
  /_get$/,
  /_search$/,
  /_timeline$/,
  /_count$/,
  /_preview$/,
  /_format$/,
  /_config$/,
  /_types$/,
  /_priorities$/,
  /_categories$/,
  /_status$/,
  /_sources$/,
  /_stats$/,
  /_report$/,
  /_responses$/,
  /_nps_score$/,
  /_rating_trends$/,
  /_by_contact$/,
  /_latest_for_contact$/,
  /_gap_nights$/,
  /_get_open$/,
  /_response_duration$/,
  /_volume_by_\w+$/,
  /_volume_stats$/,
  /_read_content$/,
  /_block_types$/,
  /_action_types$/,
  /_trigger_types$/,
  /_step_format$/,
  /_condition_format$/,
  /_condition_config$/,
  /_unit_assignments$/,
  /_detail$/,
  /_columns$/,
  /_audit$/,
  /_check$/,
  /_from_numbers$/,
]

const DESTRUCTIVE_EXACT = new Set([
  "sendsquared_contacts_merge",
  "sendsquared_campaigns_send",
  "sendsquared_sms_send",
  "sendsquared_workflows_run_existing",
  /*
    Removing a survey question also drops the answers already recorded
    against it, assigning a survey delivers it to the contact, and
    cancelling an assignment retires a live survey link — none are undoable.
  */
  "sendsquared_surveys_questions_remove",
  "sendsquared_surveys_assign",
  "sendsquared_contact_surveys_cancel",
  /*
    These four replace a whole collection rather than merging into it, so
    anything the caller leaves out of the array is deleted. A model that treats
    them as additive — a reasonable reading of "set" — silently drops the
    guidebook's existing conditions, a block's guidebook membership, or a
    block's images, none of which can be recovered from the response.
  */
  "sendsquared_guidebooks_conditions_set",
  "sendsquared_guidebook_blocks_conditions_set",
  "sendsquared_guidebook_blocks_guidebooks_set",
  "sendsquared_guidebook_blocks_set_assets",
  "sendsquared_contacts_legal_acceptance_party_members_set",
  "sendsquared_contacts_vehicles_set",
  /*
    Despite the name, this delivers real email to real addresses — the "[TEST]"
    prefix is cosmetic. It does not match the _send suffix the other send tools
    use, so it has to be listed explicitly or it would be classified as an
    ordinary non-destructive mutation.
  */
  "sendsquared_email_templates_send_test",
  "sendsquared_campaigns_test_send",
  /*
    Delivers a real one-off email to a real person and cannot be recalled. It
    does not end in _send, so the suffix rules would otherwise treat it as an
    ordinary mutation.
  */
  "sendsquared_contacts_send_email",
])

export function isReadOnlyTool(name: string): boolean {
  if (READ_ONLY_EXACT.has(name)) return true
  if (name.startsWith("sendsquared_report_") || name.startsWith("sendsquared_reports_")) return true
  return READ_ONLY_PATTERNS.some((p) => p.test(name))
}

export function isDestructiveTool(name: string): boolean {
  if (name.endsWith("_delete")) return true
  return DESTRUCTIVE_EXACT.has(name)
}

const TITLE_OVERRIDES: Record<string, string> = {
  sendsquared_doctor: "Connection diagnostics",
  sendsquared_version: "Server version",
}

export function deriveTitle(name: string): string {
  if (TITLE_OVERRIDES[name]) return TITLE_OVERRIDES[name]
  const spaced = name.replace(/^sendsquared_/, "").replace(/_/g, " ")
  const titled = spaced.charAt(0).toUpperCase() + spaced.slice(1)
  return titled
    .replace(/\bsms\b/gi, "SMS")
    .replace(/\bpms\b/gi, "PMS")
    .replace(/\burl\b/gi, "URL")
    .replace(/\bid\b/gi, "ID")
}

export function deriveAnnotations(name: string): ToolAnnotations {
  const readOnly = isReadOnlyTool(name)
  const annotations: ToolAnnotations = {
    title: deriveTitle(name),
    openWorldHint: true,
  }
  if (readOnly) {
    annotations.readOnlyHint = true
    return annotations
  }
  annotations.readOnlyHint = false
  annotations.destructiveHint = isDestructiveTool(name)
  return annotations
}
