/*
  The SendSquared MCP playbook. Exposed via the resources capability so any
  MCP client (claude.ai, Claude Code, etc.) can pull it into context to learn
  how SendSquared works without having to be retold each session.

  This is the source of truth for SendSquared LLM guidance. The Claude Code
  plugin's SKILL.md and this playbook overlap deliberately — they're two
  delivery channels for the same knowledge. When updating, update both.
*/

export const SENDSQUARED_PLAYBOOK = `# SendSquared Playbook

You're connected to the SendSquared MCP server. SendSquared is a marketing automation
platform built primarily for vacation rental, hotel, and hospitality companies. It
manages contacts, leads, reservations, segments, drip workflows, email/SMS campaigns,
and reporting — all keyed off a contact and reservation database the user's PMS
(property management system) syncs into.

You have ~80 tools available. Use \`tools/list\` to enumerate them. The naming
convention is \`sendsquared_<resource>_<action>\` (snake_case).

---

## The cardinal rule: know what you're querying

Every analytical question falls into one of two categories. **Pick the right tool
for each — they are not interchangeable.**

### Category A — Contact queries → BUILD A SEGMENT

When the user asks about **people** — *"find me the contacts who…"*, *"which guests
have…"*, *"who hasn't booked since…"*, *"show me VIP repeat guests"* — your default
move is to express the answer as a **SendSquared segment**.

**Why**: Segments evaluate conditions server-side across the entire contact +
reservation + tag + lead + campaign + SMS dataset in a single query. A client-side
loop would make hundreds of round trips, burn context, and likely hit rate limits.
Also, the resulting segment is a reusable named resource the user can re-target later
from the SendSquared web app — even a "one-shot" question has long-term value if the
answer is a named audience.

**The pattern**:

1. Call \`sendsquared_groups_condition_config\` once to confirm the live list of
   condition types and operators (the API may have more than this doc lists).
2. Construct a conditions JSON array (see "Segment condition model" below).
3. Call \`sendsquared_groups_create_segment\` to materialize the segment as a named
   group in SendSquared.
4. Call \`sendsquared_contacts_list\` with \`groupId=<newSegmentId>\` to verify the
   members and answer the user's question with concrete numbers.

**Always confirm the segment plan with the user before creating it.** Show them
the JSON you're about to submit, name and all. Segments are non-destructive (you can
delete them) but a confused user with 50 mystery segments in their dashboard is a bad
outcome.

**When NOT to create a segment**: ad-hoc single-contact lookups, counts ("how many
contacts do I have?"), or validation queries that don't need a named audience.

### Category B — Reservation queries → PAGINATE DIRECTLY

When the user asks about **bookings/stays** — *"show me all reservations in March"*,
*"what's the average revenue per booking this quarter?"*, *"list all cancelled
reservations"*, *"how many nights were booked last year?"* — you **cannot** use
segments because segments return contacts, not reservations.

Instead, paginate through the reservation list directly.

**The pattern**:

1. Call \`sendsquared_reservations_list\` with appropriate \`filter\` strings and
   a high \`limit\` (up to 1000 per page). Reservation pagination is cursor-based —
   pass \`after_id=0\` for the first page, then \`after_id=<last_id_from_previous_page>\`
   for subsequent pages.
2. Accumulate results across pages until you have all matching records or enough
   to answer the question.
3. For per-contact reservation history, prefer \`sendsquared_reservations_by_contact\`
   (returns all reservations for one contact in a single call) over filtering the
   full list by contact_id.

**Filter syntax**: each filter uses **colon-delimited** format — \`field:operator:value\`:
- \`arrival_date:gte:2024-01-01\`
- \`arrival_date:lte:2024-12-31\`
- \`status:eq:confirmed\`
- \`contact_id:eq:42\`

Operators: \`eq\` (=), \`ne\` (!=), \`gt\` (>), \`gte\` (>=), \`lt\` (<), \`lte\` (<=),
\`like\` (SQL LIKE), \`ilike\` (case-insensitive LIKE), \`in\` (comma-separated values,
e.g. \`status:in:confirmed,checked_in\`), \`null\`, \`notNull\`, \`search\` (LIKE %value%).
Multiple filters are ANDed.

**Pagination example** — iterate until after_id returns no more results:

\`\`\`
Page 1: sendsquared_reservations_list(limit=1000, after_id=0, filter=['arrival_date:gte:2024-01-01', 'arrival_date:lte:2024-03-31'])
  → got 1000 results, last id = 5842
Page 2: sendsquared_reservations_list(limit=1000, after_id=5842, filter=['arrival_date:gte:2024-01-01', 'arrival_date:lte:2024-03-31'])
  → got 347 results, done
Total: 1347 reservations matched
\`\`\`

**Useful reservation fields for filtering and analysis**: \`arrival_date\`,
\`departure_date\`, \`status\`, \`source\`, \`reservation_type\`, \`unit_type\`,
\`total_revenue\`, \`room_revenue\`, \`nights\`, \`contact_id\`, \`booking_channel\`.

**When segments and reservation queries combine**: the user asks *"find repeat guests
who booked in 2024 and 2025 but have no future booking"* — that's a **contact query**
(the answer is a list of people). Build a segment. The conditions happen to reference
reservation data (\`reservation.arrival_date\`), but the output is contacts, so it's
Category A. Use reservation pagination only when the output is **bookings**, not
people.

### Category C — Contacts filtered by their units' attributes

Some contacts have **units** (properties/parcels) assigned to them — owner-style
records, often synced from a PMS or GIS source. A unit carries an address plus a
\`custom_fields\` blob with attributes like \`bedrooms\`, \`bathrooms\`,
\`estimated_value\`, \`year_built\`, and \`sq_ft_structure\`.

Segments **cannot** filter on unit attributes — units are not a segment condition
dimension. So when the user asks *"which contacts in tag X have a 3+ bedroom unit?"*
or *"find owners whose units are worth over \$500k"*, you must enumerate.

**The pattern**:

1. List the contacts you're scoping over — e.g. \`sendsquared_contacts_list\` with
   \`tagId=<tag>\`, paginating with \`before\` (pass the previous response's
   \`nextBefore\`) until \`nextBefore\` is null.
2. For each contact, call \`sendsquared_contacts_units_list\` with \`id=<contactId>\` —
   this returns that contact's units.
3. Inspect each unit. Plain fields (\`address_1\`, \`region\`, \`postal\`,
   \`unit_type\`) are top-level; counts and valuations (\`bedrooms\`, \`bathrooms\`,
   \`estimated_value\`) live inside the unit's \`custom_fields\` object.
4. Keep the contacts whose units satisfy the criterion — e.g. any unit with
   \`custom_fields.bedrooms >= 3\`.

This is an N+1 loop — one units call per contact. It is fine for a tag of dozens to
a few hundred contacts; throttle to stay under the rate limit (10 req/s burst,
100 req/min per token). For very large tags, narrow the contact set first (a tighter
tag or a segment) before enumerating units.

### Quick decision table

| Question asks about… | Output shape | Approach |
|---|---|---|
| People / guests / contacts | List of contacts | **Build a segment** (Category A) |
| Bookings / stays / reservations | List of reservations | **Paginate reservations** (Category B) |
| Revenue / occupancy stats | Aggregated numbers | Paginate reservations (B), then compute |
| "Guests who have reservation X" | List of contacts | Segment (A) — conditions reference reservation data |
| "Reservations for guest X" | List of reservations | \`sendsquared_reservations_by_contact\` (B shortcut) |
| "Gap nights" | Future availability windows | \`sendsquared_reservations_gap_nights\` (dedicated tool) |
| "Contacts whose unit has attribute X" (bedrooms, value) | List of contacts | Enumerate contacts, then \`sendsquared_contacts_units_list\` per contact (Category C) |

---

## Segment condition model

Segments are defined by an array of **condition blocks**. Each block contains one or
more conditions that share the block's logic (\`and\` or \`or\`). Multiple blocks are
combined with **AND** at the top level.

**Effective formula**: \`(block1) AND (block2) AND (block3) ...\` where each block
is its own AND/OR expression of conditions.

### JSON shape

\`\`\`json
[
  {
    "block": 1,
    "logic": "and",
    "conditions": [
      {
        "type": "<condition_type>",
        "field": "<field_name>",
        "op": "<operator>",
        "value": "<value>",
        "valueType": "<value_type>"
      },
      ...more conditions in this block
    ]
  },
  {
    "block": 2,
    "logic": "or",
    "conditions": [...]
  }
]
\`\`\`

### Condition types

| Type | What it filters by |
|---|---|
| \`property\` | Direct contact properties (e.g. \`contacts.state\`, \`contacts.email\`, \`contacts.first_name\`, custom fields) |
| \`reservation\` | Reservation attributes (\`arrival_date\`, \`departure_date\`, \`status\`, \`source\`, \`reservation_type\`, \`unit_type\`, \`total_revenue\`, \`nights\`) |
| \`tag\` | Whether the contact has (or doesn't have) a tag (\`tag_id\`) |
| \`lead\` | Lead state (\`status_id\`, \`category_id\`, \`source_id\`, \`value\`) |
| \`campaign\` | Campaign engagement (\`opened\`, \`clicked\`, \`bounced\`, \`unsubscribed\`) for a specific campaign |
| \`sms\` | SMS engagement (sent, delivered, replied) for a specific SMS campaign |
| \`sms_opt\` | SMS opt-in status |
| \`segment\` | Membership in another segment (compose segments) |
| \`survey\` | Survey response data |
| \`cart_abandon\` | E-commerce cart abandonment events |
| \`contact_email\` | Email-level engagement aggregated across all sends |
| \`contact_unit_week\` | Per-unit, per-week reservation history (advanced) |
| \`airbnb\` | Airbnb-specific reservation fields |

### Operators

| Operator | Meaning |
|---|---|
| \`equal\` | Exact match |
| \`notEqual\` | Anything but |
| \`in\` | Value is in a comma-separated list |
| \`notIn\` | Value is not in a comma-separated list |
| \`greater\` / \`greaterOrEqual\` | Numeric or date comparison |
| \`less\` / \`lessOrEqual\` | Numeric or date comparison |
| \`like\` | SQL LIKE pattern (\`%@gmail.com\`) |
| \`notLike\` | Inverse LIKE |
| \`isNull\` | Field has no value |
| \`isNotNull\` | Field has a value |

### Value types

\`string\`, \`integer\`, \`number\`, \`datetime\`, \`datetimeRelative\`, \`datetimeMonth\`,
\`time\`, \`date\`, \`dateRange\`, \`boolean\`, \`null\`.

For relative dates, \`datetimeRelative\` values are a **signed offset in seconds from now**:
**negative = past, positive = future**. Examples: \`-7776000\` = 90 days ago,
\`-86400\` = yesterday, \`604800\` = 7 days from now.

Sign matters. Fields that only hold past timestamps (\`last_open_email\`,
\`last_click_email\`, \`last_booking\`, etc.) with a positive value silently return
zero contacts — the query is valid but semantically empty. To find contacts who
opened email "in the last 90 days", use \`greaterOrEqual\` with \`-7776000\`, not
\`7776000\`.

When in doubt, prefer absolute \`datetime\` values in \`YYYY-MM-DD\` format and let
the user specify the date range explicitly.

### Worked examples

**Example 1 — High-spending CA guests with a specific tag**

\`\`\`json
[
  {
    "block": 1,
    "logic": "and",
    "conditions": [
      { "type": "property",    "field": "contacts.state", "op": "equal", "value": "CA", "valueType": "string" },
      { "type": "tag",         "field": "tag_id",         "op": "equal", "value": "5",  "valueType": "integer" },
      { "type": "reservation", "field": "total_revenue",  "op": "greater", "value": "5000", "valueType": "number" }
    ]
  }
]
\`\`\`

**Example 2 — Year-over-year repeat guests (the canonical query)**

The user wants guests who booked in 2024 AND in 2025. Two blocks AND'd together:

\`\`\`json
[
  {
    "block": 1,
    "logic": "and",
    "conditions": [
      { "type": "reservation", "field": "arrival_date", "op": "greaterOrEqual", "value": "2024-01-01", "valueType": "datetime" },
      { "type": "reservation", "field": "arrival_date", "op": "lessOrEqual",    "value": "2024-12-31", "valueType": "datetime" }
    ]
  },
  {
    "block": 2,
    "logic": "and",
    "conditions": [
      { "type": "reservation", "field": "arrival_date", "op": "greaterOrEqual", "value": "2025-01-01", "valueType": "datetime" },
      { "type": "reservation", "field": "arrival_date", "op": "lessOrEqual",    "value": "2025-12-31", "valueType": "datetime" }
    ]
  }
]
\`\`\`

To **also** require "no future booking", build a second segment for "has future
booking" then use the segment composition pattern below to subtract.

**Example 3 — Compose segments (subtract one from another)**

Use \`type: "segment"\` to compose. Build a "has future booking" segment first
(condition: \`reservation.arrival_date >= today\`), then build a "year-over-year
repeat" segment that ALSO has a condition \`segment / segment_id / notEqual /
<future_booking_segment_id>\`. The result: repeat guests with no future booking.

\`\`\`json
[
  ...the year-over-year blocks above...,
  {
    "block": 3,
    "logic": "and",
    "conditions": [
      { "type": "segment", "field": "segment_id", "op": "notEqual", "value": "<future_booking_segment_id>", "valueType": "integer" }
    ]
  }
]
\`\`\`

**Example 4 — Engaged contacts who didn't open the last campaign**

\`\`\`json
[
  {
    "block": 1,
    "logic": "and",
    "conditions": [
      { "type": "campaign", "field": "campaign_id", "op": "equal", "value": "<campaignId>", "valueType": "integer" },
      { "type": "campaign", "field": "opened",      "op": "equal", "value": "false",         "valueType": "boolean" }
    ]
  }
]
\`\`\`

---

## Workflow trigger and action model

Workflows are multi-step automations that fire when a trigger event happens to a
contact. They can branch, wait, send emails/SMS/postcards, fire webhooks, apply
tags, and create tasks.

### Trigger model

A workflow has exactly one trigger. The trigger defines **when** the workflow runs
for a contact.

**Trigger structure**:

\`\`\`json
{
  "trigger_type":  "<type>",
  "trigger_value": "<event>",
  "conditions":    []
}
\`\`\`

**Common trigger types** (call \`sendsquared_workflows_trigger_types\` for the live
list — what's available depends on the company's PMS integration):

| Trigger type | Common trigger_value(s) | When it fires |
|---|---|---|
| \`group\` | \`group.join\`, \`group.leave\` | Contact joins/leaves a specific group or segment. **Most common** — pair with a segment. |
| \`tag\` | \`tag.join\`, \`tag.leave\` | Contact gains/loses a specific tag |
| \`reservation\` | \`reservation.created\`, \`reservation.cancelled\`, \`reservation.checked_in\`, \`reservation.checked_out\` | Reservation lifecycle event |
| \`time_based\` | \`arrival_date\`, \`departure_date\`, \`birthday\` | Fires N days before/after a date field |
| \`property\` | (field name) | A contact property changes |
| \`lead\` | \`lead.created\`, \`lead.status_changed\` | Lead lifecycle event |

### Action model (steps)

The workflow's \`action\` field is a **deeply nested tree** of steps. Each step has:

- \`type\`: \`Email\`, \`Sms\`, \`Whatsapp\`, \`PostCard\`, \`Webhook\`, \`Survey\`, \`Wait\`, \`Tag\`, \`TagContact\`, \`Task\`, \`Airbnb\`
- \`value\`: for \`Wait\` it's a duration string (\`30s\`, \`5m\`, \`2h\`, \`1d\`, \`1w\`); for everything else it's a template/resource id (number)
- \`label\`: optional human-readable description
- \`condition\`: optional — branches the workflow based on contact state (same shape as segment conditions but with \`operator\`/\`operand\` field names)
- \`children\`: array of next steps. The MCP tool's stepsToNestedTree helper converts a flat array into the spine the API expects, so you can pass a flat list to \`sendsquared_workflows_create\` and it'll be nested for you.

### Worked example — 6-month welcome drip with branching

\`\`\`json
[
  { "type": "Email", "value": 42, "label": "Welcome email" },
  { "type": "Wait",  "value": "7d" },
  {
    "type": "Email", "value": 55, "label": "Week 1 follow-up — only if didn't open welcome",
    "condition": {
      "type": "campaign", "operator": "equal", "operand": "opened",
      "value": "false", "valueType": "boolean"
    }
  },
  { "type": "Wait", "value": "30d" },
  { "type": "Sms",  "value": 12, "label": "Month 1 check-in" },
  {
    "type": "Wait", "value": "150d",
    "children": [
      { "type": "Email", "value": 88, "label": "6-month re-engagement" }
    ]
  }
]
\`\`\`

---

## Tool reference (most important tools)

Full list via \`tools/list\`. Highlights:

### Reading data

- \`sendsquared_contacts_list\` / \`sendsquared_contacts_get\` / \`sendsquared_contacts_search\` / \`sendsquared_contacts_timeline\`
- \`sendsquared_reservations_list\` / \`sendsquared_reservations_get\` / \`sendsquared_reservations_by_contact\` / \`sendsquared_reservations_latest_for_contact\` / \`sendsquared_reservations_count\`
- \`sendsquared_campaigns_list\` / \`sendsquared_campaigns_get\` / \`sendsquared_campaigns_report\`
- \`sendsquared_groups_list\` / \`sendsquared_groups_get\`
- \`sendsquared_workflows_list\` / \`sendsquared_workflows_get\`
- \`sendsquared_leads_list\`, \`sendsquared_tags_list\`, \`sendsquared_email_templates_list\`, \`sendsquared_sms_templates_list\`
- \`sendsquared_surveys_list\` / \`sendsquared_surveys_get\` / \`sendsquared_surveys_report\` / \`sendsquared_surveys_nps_score\`
- \`sendsquared_reports_run\` with any type from \`sendsquared_reports_types\` (same reports as the web app); shortcuts \`reports_automation_activity\` / \`_automation_steps\` / \`_automation_detail\` / \`reports_email\` / \`reports_sms\` / \`reports_growth\`
- \`sendsquared_surveys_audit\` — sent → started → completed per sending automation, plus \`sendsquared_surveys_responses_report\` for every assignment

### Creating segments and workflows

- \`sendsquared_groups_create_segment\` — **the primary tool for analytical questions**
- \`sendsquared_groups_condition_config\` / \`sendsquared_groups_condition_format\` — discover the live condition vocabulary
- \`sendsquared_workflows_create\` — multi-step automations
- \`sendsquared_workflows_trigger_types\` / \`sendsquared_workflows_action_types\` / \`sendsquared_workflows_step_format\`

### Sending things

- \`sendsquared_campaigns_create\` then \`sendsquared_campaigns_send\`
- \`sendsquared_sms_send\` (single, ad-hoc)
- \`sendsquared_workflows_run_existing\` (process existing group members through a workflow)

### Email templates

- \`sendsquared_email_templates_list\` / \`sendsquared_email_templates_get\` — list or fetch the **metadata** record (name, subject, preview, thumbnail, flags). \`_get\` does **not** return the HTML body.
- \`sendsquared_email_templates_read_content\` — fetches the full Stripo HTML/compiled content. The body is stored in S3, so this tool first asks the API for a short-lived signed URL and then downloads the JSON payload (\`html\`, \`compiled\`, \`ampCompiled\`, \`css\`). Use this before editing a template so you can see (and preserve) the markup you're modifying.
- \`sendsquared_email_templates_create\` — runs the full Stripo 3-step flow (POST metadata → PUT HTML to signed URL → PUT /complete). Pass a complete Stripo-compatible HTML document. Read \`sendsquared://stripo-reference\` (markup patterns) AND \`sendsquared://merge-tokens\` (available merge tokens + the guidebook/survey/unsubscribe special URLs) first.
- \`sendsquared_email_templates_update\` — updates an existing template. Pass only the fields you want to change (\`name\`, \`subject\`, \`preview\`, and/or \`html\`); the rest are preserved from the current record. When \`html\` is supplied, the same 3-step flow runs (PUT metadata → upload HTML → /complete) and the thumbnail/merge tokens are regenerated. Pair it with \`_read_content\` for targeted edits to the existing markup.
- \`sendsquared_email_templates_duplicate\` / \`_preview\` / \`_archive\` / \`_delete\` — lifecycle actions. \`_delete\` is destructive; confirm with the user.

### Template folders

Folders are how a company keeps its email template library tidy. When a user asks to "clean up" or "organize" their templates, this is the workflow:

1. \`sendsquared_folders_list\` — see the existing folder tree. Each folder has a \`path\` like \`MAINE / Maine_Guest\` so nesting is obvious. Reuse existing folders before creating new ones.
2. \`sendsquared_email_templates_list\` — walk every template with the cursor: \`limit: 200\`, \`after_id: 0\`, then keep passing \`next_after_id\` until it comes back null. The API has no grand total, so the walk is the only way to be sure you've seen everything. The \`folder\` array on each record tells you where it lives; an empty array means unfiled. Pass \`folder_id\` to see one folder's contents, or \`folder_id: 0\` for only the unfiled ones. Archived templates are hidden unless you pass \`archived: true\`.
3. Propose a layout and confirm it with the user before moving anything — folder names, which templates go where, and which folders to retire.
4. \`sendsquared_folders_create\` (with \`parent_id\` for nesting) and \`sendsquared_folders_rename\` to shape the tree.
5. \`sendsquared_email_templates_set_folder\` with an \`ids\` array to move templates in batches. A template lives in exactly one folder; moving it replaces the previous one. Failures are reported per id and don't stop the batch.
6. \`sendsquared_folders_delete\` to remove empty or redundant folders. It is destructive for the folder only — templates inside are unfiled, never deleted — and child folders are left in place, so empty a folder and clear its children first.

Group templates by how the company actually uses them (by property or region, by audience such as guests vs owners, by purpose such as automations vs campaigns) rather than by template type. Leave system templates where they are unless asked.

### Surveys

A survey is one document: its settings, its ordered questions (each with its own options), the buttons on its thank-you page (\`end_links\`), and the rules that turn responses into tasks (\`task_configs\`).

- \`sendsquared_surveys_list\` / \`sendsquared_surveys_get\` — \`_get\` returns the full document; \`_list\` with \`stats=true\` adds response counts.
- \`sendsquared_surveys_create\` — needs \`name\`, \`send_method\`, \`from_id\` (a verified email id for email, a phone number id for SMS) and at least one question. New surveys start inactive.
- \`sendsquared_surveys_questions_add\` / \`_questions_update\` / \`_questions_remove\` / \`_questions_reorder\` — **prefer these for question edits.** Each reads the survey, changes one question, and writes the whole document back.
- \`sendsquared_surveys_update\` — settings and whole-list replacements.
- \`sendsquared_surveys_end_links_set\` / \`_task_configs_set\` — conditional thank-you links and automatic follow-up tasks.
- \`sendsquared_surveys_duplicate\` — the safe way to revise a survey that already has responses.
- \`sendsquared_surveys_assign\` — send a survey to one contact; \`sendsquared_contact_surveys_list\` / \`_responses\` read what came back.

**The one thing that will bite you:** every survey write is a full replace. Anything missing from the payload is deleted — questions, options, end links, task configs alike. The tools guard this by reading the survey first and carrying everything forward, but if you pass \`questions\` to \`sendsquared_surveys_update\` you are replacing the entire list: include each existing question's \`id\` (and each option's \`id\`) or they will be deleted and recreated, losing their recorded answers.

Question types are \`yesNo\`, \`rating\`, \`radio\`, \`multiple\`, and \`text\`. Only \`radio\` and \`multiple\` take an \`answers\` list. Set \`calculation_type: "nps"\` on a rating question to make it feed \`sendsquared_surveys_nps_score\`, or \`"zscore"\` for relative scoring.

End link and task config conditions use the same operator vocabulary as segments — \`equal\`, \`greater\`, \`less\`, and so on, spelled out in full. The \`survey_responses.*\` operands (\`rating\`, \`nps_score\`, \`answer\`, \`yes_no\`, \`nps_category\`, \`is_promoter\`, \`is_detractor\`, \`is_passive\`) each read one question and require a \`question_id\`; the \`contact_surveys.*\` operands (\`response_count\`, \`has_responded\`, \`completed_at\`, \`created_at\`, \`composite_score\`) describe the assignment as a whole.

Surveys cannot be deleted — retire one by updating it with \`active: false\`.

**Read → edit → update pattern** for modifying an existing template:

1. \`sendsquared_email_templates_get\` — metadata, to confirm you have the right template.
2. \`sendsquared_email_templates_read_content\` — pulls the current HTML body from S3.
3. Modify the HTML locally (keeping the Stripo nesting intact — see \`sendsquared://stripo-reference\`).
4. \`sendsquared_email_templates_update\` with the new \`html\` (and any metadata changes). The tool handles re-upload and finalization.
5. Optionally \`sendsquared_email_templates_preview\` to verify the rendered output before sending.

---

## Decision flowcharts

### "Find me contacts/guests who…"

1. Call \`sendsquared_groups_condition_config\` to confirm field availability (one round trip, cached server-side after first call)
2. Build a conditions JSON
3. **Show the user the planned segment name + conditions JSON before creating it**
4. \`sendsquared_groups_create_segment\`
5. \`sendsquared_contacts_list\` with the new groupId to enumerate members and report back

### "I want to send a welcome series to new bookings"

1. Confirm the trigger: a contact-level event (reservation created) or a segment join?
2. If segment-based: \`sendsquared_groups_create_segment\` for the target audience
3. \`sendsquared_email_templates_list\` to find existing welcome templates, or \`sendsquared_email_templates_create\` for new ones
4. \`sendsquared_workflows_create\` with the steps array
5. Show the user the workflow before activating it
6. \`sendsquared_workflows_update\` with \`active=true\` after user approves
7. Optionally \`sendsquared_workflows_run_existing\` to process current group members

### "How is campaign X performing?"

1. \`sendsquared_campaigns_get\` for metadata
2. \`sendsquared_campaigns_report\` (parallel) for the metrics
3. \`sendsquared_reports_email\` with from/to (parallel) for account-level baselines
4. Compare and report — flag anything unusual (high bounce rate, low CTR vs baseline, etc.)

### "Why isn't this working?"

1. \`sendsquared_doctor\` — verifies token, connectivity, and the user's identity
2. \`sendsquared_version\` — confirms API reachability
3. Check the user's auth state — token may be expired

---

## Invariants

- **Always confirm destructive actions** with the user before calling them: \`*_delete\` for any resource, \`sendsquared_campaigns_send\`, \`sendsquared_workflows_run_existing\`, \`sendsquared_contacts_merge\`. Show them what will happen and the count of affected records when possible.
- **All ids are strings** in tool inputs even when they look numeric.
- **Pagination defaults** vary by tool — most lists default to page 1, limit 25; reservations defaults to limit 100 with cursor-based pagination via \`after_id\`.
- **Date format** in tool inputs is ISO \`YYYY-MM-DD\` unless otherwise documented.
- **Throttle defensively**. The SendSquared API does not currently enforce strict rate limits, but the MCP server does (10 req/s burst, 100 req/min sustained per token). Don't loop over thousands of records — use segments to push the work server-side.
- **Prefer segments** for analytical questions. See "The cardinal rule" above.
- **The breadcrumbs field** in every tool response suggests the next tool to call. Use them to navigate without asking the user "what next?" on every step.
- **The user's company context** is implicit in the JWT — you don't need to pass a company id to any tool. It is fixed for the session; to act as a different company the user re-authenticates with that company's token.

---

## PMS sync model — where data comes from

SendSquared is not the system of record for reservation data. Reservations flow in
from the customer's **Property Management System** (PMS) — Hostaway, Guesty, Lodgify,
OwnerRez, Escapia, Streamline, VRBO direct, Airbnb, Booking.com channel managers,
etc. SendSquared syncs this data on a schedule (typically every 15–60 minutes
depending on the integration).

**What this means for you**:

- **Never suggest creating or modifying reservations through SendSquared.** There is
  no \`sendsquared_reservations_create\` or \`_update\` tool because reservations are
  PMS-sourced. If the user asks to "add a reservation", redirect them to their PMS.
- **Reservation data may lag behind reality** by up to an hour. If the user says
  "I just got a new booking but it's not showing up", it's a sync delay, not a bug.
  Tell them to check back shortly or verify in their PMS directly.
- **Contact records are created automatically** when a reservation syncs for a new
  guest. The contact's \`source\` field indicates where they came from (e.g. "Airbnb",
  "Direct", "Booking.com"). This field is PMS-sourced and should not be manually
  overridden unless the user explicitly asks.
- **Custom fields on contacts** can be either PMS-sourced (mapped during integration
  setup) or user-created. If the user asks about a custom field you don't recognize,
  it may be PMS-mapped — suggest they check their integration settings in the
  SendSquared web app.
- **Units (properties/rooms)** are synced from the PMS. The \`units\` relation on a
  reservation tells you which property the guest stayed at. Units are not directly
  manageable through the MCP — they're read-only reference data.

**PMS-sourced fields on reservations** (treat as read-only):
\`arrival_date\`, \`departure_date\`, \`status\`, \`total_revenue\`, \`room_revenue\`,
\`extra_revenue\`, \`taxes\`, \`nights\`, \`adults\`, \`children\`, \`pets\`,
\`source\`, \`booking_channel\`, \`reservation_type\`, \`unit_type\`,
\`confirmation_code\`, \`pms_id\`, \`external_id\`.

**SendSquared-managed fields** (you can create/modify):
Tags, groups/segments, leads, workflows, campaigns, email templates, custom fields
explicitly created by the user.

---

## Contact deduplication

Duplicate contacts are common in hospitality because guests book through multiple
channels (Airbnb for one trip, direct booking for another) and the PMS may create
separate guest records for each.

**When to use \`sendsquared_contacts_merge\`**:
- The user explicitly identifies two contacts as the same person and wants to combine
  them. The merge keeps the **primary** contact and folds the secondary's data
  (reservations, timeline events, tags) into it. The secondary contact is removed.
- Always **confirm with the user** before merging — show both contacts side by side
  (email, name, phone, reservation count) and ask which should be the primary.
- Merging is **irreversible**. If you're not sure two contacts are the same person,
  say so. Better to leave a dupe than to merge two real people.

**When NOT to merge**:
- Don't proactively scan for and merge duplicates unless the user specifically asks
  for a deduplication pass. Mass dedup is risky without human review.
- If the user's PMS handles deduplication (some do), tell them to manage it there
  rather than in SendSquared — the next PMS sync could re-create the dupe.

**Common dupe patterns**:
- Same email, different name spellings (John vs Jon). These are almost always the
  same person — safe to merge after confirmation.
- Same name, different email. Might be the same person with a personal vs work email,
  or might be two different people. Ask the user.
- Same phone, different email. Similar ambiguity — ask.

---

## Revenue attribution

Revenue data in SendSquared comes from the PMS and reflects the booking-level
financials. Getting revenue numbers right is high-stakes — wrong numbers in a
report erode trust immediately.

**CRITICAL: ALL REVENUE VALUES ARE IN CENTS.** Every monetary field in the
SendSquared API stores values in cents (integer). Divide by 100 to get dollars
before displaying to the user. For example, \`total_revenue: 500000\` means
**$5,000.00**, not $500,000. Always convert before presenting numbers.

**Key revenue fields on reservations** (all in cents):
- \`total_revenue\`: the full booking value including room rate, extras, fees, and
  taxes. This is the "headline" number for a reservation. **Divide by 100 for dollars.**
- \`room_revenue\`: the room-rate portion only, excluding extras and taxes. Use this
  for ADR (Average Daily Rate) and RevPAR calculations. **Divide by 100.**
- \`extra_revenue\`: add-ons, cleaning fees, pet fees, etc. **Divide by 100.**
- \`taxes\`: tax portion. Usually not included in operational metrics. **Divide by 100.**
- \`total_paid\`: what the guest has actually paid so far. **Divide by 100.**
- \`deposit\`: amount held as a deposit. **Divide by 100.**

**How to avoid double-counting**:
- **Cancelled reservations**: check \`status\` — cancelled reservations should be
  excluded from revenue reports unless the user explicitly asks to include them.
  A cancelled booking with \`total_revenue = $5000\` was never realized revenue.
- **Modified reservations**: if a guest extends or shortens their stay, the PMS
  updates the existing reservation record (same id, new dates/revenue). There's no
  duplicate — the latest sync is the truth.
- **Multi-unit bookings**: some guests book multiple units for the same dates. These
  are separate reservation records, each with their own revenue. They should be
  summed, not deduplicated — the guest really did generate that much revenue.

**Common metrics the user will ask for**:
- **ADR** (Average Daily Rate): \`sum(room_revenue) / sum(nights)\` across the
  filtered reservation set. Use only confirmed/checked-in/checked-out statuses.
- **RevPAR** (Revenue Per Available Room): \`total_room_revenue / (total_units *
  nights_in_period)\`. Requires knowing the total unit count — call
  \`sendsquared_reservations_types\` or ask the user.
- **Occupancy rate**: \`sum(booked_nights) / (total_units * nights_in_period)\`.
- **Total revenue for period**: paginate reservations with
  \`arrival_date:gte:YYYY-MM-DD\` and \`arrival_date:lte:YYYY-MM-DD\`, sum \`total_revenue\`, exclude cancelled.

**When in doubt about a revenue number, show your math.** State which reservations
you included, which statuses you filtered, and what field you summed. Let the user
catch errors before they act on them.

---

## Tag taxonomy patterns

Tags in SendSquared are user-defined labels applied to contacts (and sometimes
reservations). They're the most flexible organizational tool but also the messiest
if used without discipline.

**Common tag strategies in hospitality**:

| Strategy | Example tags | Use case |
|---|---|---|
| **Lifecycle stage** | \`New Lead\`, \`First Stay\`, \`Repeat Guest\`, \`VIP\`, \`Churned\` | Segmenting by guest relationship depth |
| **Interest/preference** | \`Pet Friendly\`, \`Oceanfront\`, \`Large Group\`, \`Romantic Getaway\` | Personalizing campaign content |
| **Source channel** | \`Airbnb Guest\`, \`Direct Booker\`, \`Referral\`, \`Event Attendee\` | Tracking acquisition channels (supplements the \`source\` field on reservations) |
| **Marketing consent** | \`Email Opted In\`, \`SMS Opted In\`, \`Do Not Contact\` | Compliance enforcement |
| **Operational** | \`Flagged for Review\`, \`VIP Upgrade Eligible\`, \`Repeat No-Show\` | Internal staff workflows |

**When to use tags vs. segments vs. leads**:
- **Tags**: binary state (has it or doesn't). Good for permanent or semi-permanent
  labels. Applied manually, by workflow, or by integration. Cheap to query.
- **Segments**: dynamic membership based on conditions. Good for "who matches these
  criteria right now?" questions. Membership updates automatically as data changes.
  Use when the criteria might change or when you want automatic recalculation.
- **Leads**: sales-pipeline tracking with stages, categories, sources, and monetary
  values. Use when you're tracking a specific sales opportunity, not just labeling
  a contact.

**When the user asks "organize my contacts"**: ask them what they're trying to
accomplish. If it's "I want to send different emails to different groups", that's
segments. If it's "I want to mark certain guests as VIP", that's tags. If it's
"I want to track which guests might rebook and how much that's worth", that's leads.

---

## SMS compliance

SendSquared can send SMS messages via \`sendsquared_sms_send\` (one-off) or through
workflow steps and campaigns. SMS is powerful for hospitality (pre-arrival info,
check-in instructions, post-stay review requests) but carries **legal compliance
requirements** that you must respect.

**Rules Claude must follow for any SMS-related action**:

1. **Never send SMS to a contact who hasn't opted in.** Before suggesting an SMS
   send, ask the user to confirm the recipient(s) have SMS consent. If building a
   segment for an SMS campaign, include an \`sms_opt\` condition to filter to
   opted-in contacts only.

2. **Respect quiet hours.** Most US jurisdictions prohibit commercial SMS before
   8am and after 9pm in the recipient's local timezone. SendSquared handles this
   at the platform level for campaigns, but for ad-hoc \`sendsquared_sms_send\`
   calls, warn the user if the time seems inappropriate. When in doubt, ask.

3. **Include opt-out language.** For marketing SMS (not transactional), the message
   should include "Reply STOP to unsubscribe" or equivalent. SendSquared
   auto-appends this for campaigns but may not for ad-hoc sends. Remind the user.

4. **Character limits.** SMS segments are 160 characters (GSM-7) or 70 characters
   (UCS-2, which kicks in if the message contains emoji or non-Latin characters).
   Messages longer than one segment are split and charged as multiple messages.
   Keep marketing SMS **under 160 characters** when possible.

5. **Transactional vs. marketing**. Pre-arrival instructions, check-in codes, and
   reservation confirmations are **transactional** (less regulated, can be sent
   without explicit marketing consent if the guest has a booking). Marketing
   messages (promotions, re-engagement, upsells) require explicit opt-in.

**When SMS is better than email** (hospitality-specific):
- Pre-arrival (1-2 days out): open rates are 98% for SMS vs ~20% for email
- Check-in/check-out instructions: time-sensitive, SMS is immediate
- Last-minute gap-night offers: the booking window is too short for email
- Post-stay review requests: within 24 hours of checkout for highest response

**When email is better**:
- Long-form content (welcome guides, area recommendations)
- Campaigns with images (property photos, seasonal promotions)
- Drip sequences longer than 3 touchpoints (SMS fatigue sets in fast)
- Any message where you want click tracking

---

## Seasonal patterns in hospitality

Vacation rental and hotel marketing is deeply seasonal. The effectiveness of every
campaign, the urgency of every message, and the booking behavior of every guest
segment shifts with the calendar. Claude should be aware of these patterns when
making marketing suggestions.

**The three seasons** (varies by market, but the pattern is universal):

| Season | Typical months (US) | Booking behavior | Marketing implications |
|---|---|---|---|
| **High season** | Jun–Aug (summer), Dec–Jan (holidays/ski) | High occupancy, high ADR, short booking windows. Guests book 3-6 months ahead. | Focus on upsells and experience add-ons, not discounts. Fill gap nights aggressively. Re-engagement is less urgent — demand is organic. |
| **Shoulder season** | Apr–May, Sep–Oct | Moderate occupancy, moderate ADR, longer booking windows. Price-sensitive guests. | Best ROI on re-engagement campaigns. Offer value (packages, extended-stay discounts). Target repeat guests who came during high season — they already love the property. |
| **Off season** | Nov, Feb–Mar (varies) | Low occupancy, low ADR, very long booking windows or last-minute. | Steepest discounts are acceptable. Focus on local/regional guests (shorter drive = lower commitment). "Escape the cold" messaging for warm-climate markets. |

**Booking windows by channel**:
- **Direct bookings**: longest lead time (2-6 months). Best for early-bird campaigns.
- **Airbnb/VRBO**: medium lead time (1-3 months). Guests compare properties.
- **Booking.com**: shortest lead time (days to 2 weeks). Last-minute travelers.
- **Repeat guests**: variable but often book early for their "usual" dates.

**Calendar-aware campaign suggestions**:

When the user asks to build a campaign and doesn't specify timing, consider the
current date and the typical seasonal calendar for their market:

- **3-4 months before high season**: "Book early" campaign to repeat guests. Build
  a segment of guests who stayed during last year's high season and haven't booked
  yet for this year.
- **1-2 months before shoulder season**: "Shoulder season value" campaign. Target
  guests who've shown price sensitivity (booked during off/shoulder before) or
  high-season guests who might enjoy a quieter visit.
- **During high season**: gap-night filler campaigns. Use
  \`sendsquared_reservations_gap_nights\` to find 1-3 night gaps between bookings
  and target nearby guests or past short-stay guests.
- **Start of off season**: "We miss you" re-engagement to dormant contacts who
  haven't booked in 12+ months. Use the \`dormant_reengagement\` prompt.
- **Year-round**: post-stay review requests (workflow triggered by checkout), and
  anniversary campaigns ("it's been one year since your stay at…").

**Don't assume the user's market matches US seasonality.** Beach markets, ski
markets, urban markets, and international destinations all have different peaks.
If you're not sure, ask: "When is your high season?" before building
calendar-dependent campaigns. One question saves a campaign sent at the wrong time.
`
