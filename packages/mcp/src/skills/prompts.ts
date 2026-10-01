/*
  MCP prompts for SendSquared. Each prompt is a parameterized markdown template
  that gets rendered with the user's arguments and sent to Claude. They appear
  to users as slash commands (Claude Code) or suggested actions (claude.ai).

  Design rule: prompts here are for multi-step ORCHESTRATIONS, not for
  hyper-specific segment templates. If a query can be expressed as "create one
  segment from natural language", let the playbook resource teach Claude how
  to compose it on the fly — don't bake a prompt for it. Prompts here are for
  flows that span multiple resources (segment + workflow + templates + sends)
  or that need a multi-turn user dialog.
*/

export interface PromptArgument {
  name: string
  description: string
  required?: boolean
}

export interface PromptDefinition {
  name: string
  description: string
  arguments: PromptArgument[]
  render: (args: Record<string, string>) => string
}

function arg(name: string, description: string, required = false): PromptArgument {
  return { name, description, required }
}

function get(args: Record<string, string>, name: string, fallback = ""): string {
  const v = args[name]
  return typeof v === "string" && v.length > 0 ? v : fallback
}

const repeatGuests: PromptDefinition = {
  name: "repeat_guests",
  description:
    "Find SendSquared guests who have booked across multiple years, optionally excluding those with a future booking. " +
    "Builds a SendSquared segment using the segment-first pattern, then enumerates the members.",
  arguments: [
    arg("year_a", "First year to require a booking in (e.g. 2024)", true),
    arg("year_b", "Second year to require a booking in (e.g. 2025)", true),
    arg("exclude_future_booking", "If 'true', also exclude guests who already have a future booking", false),
  ],
  render: (args) => {
    const a = get(args, "year_a")
    const b = get(args, "year_b")
    const excl = get(args, "exclude_future_booking").toLowerCase() === "true"
    return `Find SendSquared guests who booked in **both ${a} and ${b}**${excl ? ", excluding those who already have a future reservation" : ""}.

Follow the segment-first pattern from the SendSquared playbook:

1. Call \`sendsquared_groups_condition_config\` to confirm the live condition vocabulary supports \`reservation\` with \`arrival_date\` field comparisons.
2. Construct a segment with two condition blocks (one per year), each requiring \`arrival_date\` to fall within that year's window. The blocks are AND'd together so the contact must satisfy both years.
${excl ? `3. Build a separate "has future booking" segment first (single block, single condition: \`reservation.arrival_date >= today\`). Then add a third block to the year-over-year segment that requires \`segment / segment_id / notEqual / <future_booking_segment_id>\`.` : ""}
${excl ? "4" : "3"}. Show me the planned segment name and the full conditions JSON. Wait for me to confirm before creating anything.
${excl ? "5" : "4"}. After I confirm: call \`sendsquared_groups_create_segment\` to create it, then \`sendsquared_contacts_list\` with the new groupId to enumerate members.
${excl ? "6" : "5"}. Report the count and a representative sample (top 10 by total_revenue if available, otherwise alphabetical). End with breadcrumbs for what I might want to do next (e.g. build a re-engagement workflow).

Use the year-over-year worked example in the SendSquared playbook resource as a reference. Read it via the resources capability if you haven't already.`
  },
}

const dripCampaign: PromptDefinition = {
  name: "drip_campaign",
  description:
    "Interactively design and create a SendSquared drip campaign. Walks through audience, goal, channels, and schedule, then builds a workflow with the appropriate trigger and steps. Multi-turn — does not create anything until explicitly approved.",
  arguments: [
    arg("goal", "Short description of what the drip should accomplish (welcome new bookings, re-engage dormant contacts, post-stay feedback, etc.)", false),
    arg("audience", "Who the drip targets (new signups, repeat guests, contacts in segment X, etc.)", false),
    arg("channels", "Comma-separated channels: email, sms, postcard, mixed", false),
  ],
  render: (args) => {
    const goal = get(args, "goal", "(not specified — ask the user)")
    const audience = get(args, "audience", "(not specified — ask the user)")
    const channels = get(args, "channels", "(not specified — ask the user)")
    return `Help me build a SendSquared drip campaign. Initial intent:
- **Goal**: ${goal}
- **Audience**: ${audience}
- **Channels**: ${channels}

This is a collaborative multi-turn flow. Do NOT create anything in SendSquared until I have explicitly approved the final plan.

## Phase 1 — Understand
If any of goal, audience, or channels are unspecified or vague, ask me clarifying questions before proceeding. Specifically nail down: how long the sequence runs, how many touchpoints, any branching rules (e.g. only follow up if they didn't open), and whether existing members of the trigger group should be processed retroactively.

## Phase 2 — Discover
Run these in parallel (one tool call per line, all in the same response):
- \`sendsquared_workflows_action_types\`
- \`sendsquared_workflows_trigger_types\`
- \`sendsquared_email_templates_list\` (limit 50)
- \`sendsquared_sms_templates_list\` (limit 50)
- \`sendsquared_groups_list\` (limit 50)

Identify which existing templates fit the goal. If none fit, plan to create them in phase 4 with \`sendsquared_email_templates_create\`.

## Phase 3 — Draft
Produce a markdown table showing every step in order: type (Email/Sms/Wait), label, template id, delay, branching condition. Include the trigger type/value at the top. Show me the plan and ask explicit "yes / change / cancel". If the right segment doesn't exist for the audience, draft the segment conditions JSON in the same response.

## Phase 4 — Build (only after approval)
1. If a new segment is needed: \`sendsquared_groups_create_segment\`
2. If new templates are needed: \`sendsquared_email_templates_create\` for each
3. \`sendsquared_workflows_create\` with the full \`steps\` JSON and the trigger
4. \`sendsquared_workflows_get\` to verify it landed correctly
5. Ask whether to run it against existing trigger-group members via \`sendsquared_workflows_run_existing\`

## Invariants
- Workflows are created **inactive** by default. After verifying, ask me whether to activate via \`sendsquared_workflows_update\` with \`active=true\`.
- Never call \`sendsquared_workflows_run_existing\` without explicit confirmation — it can blast a campaign to thousands of contacts immediately.
- Reference the playbook resource for the workflow step JSON shape and the 6-month drip example.`
  },
}

const dormantReengagement: PromptDefinition = {
  name: "dormant_reengagement",
  description:
    "Build a re-engagement campaign for SendSquared contacts who haven't engaged in N days. Creates a 'dormant' segment, then offers to attach a multi-step re-engagement workflow.",
  arguments: [
    arg("dormant_days", "How many days of inactivity counts as dormant (default: 365)", false),
    arg("definition", "What 'dormant' means: 'no_open' (no campaign opens), 'no_booking' (no recent reservation), or 'both'", false),
  ],
  render: (args) => {
    const days = get(args, "dormant_days", "365")
    const def = get(args, "definition", "no_open")
    return `Build a re-engagement campaign for SendSquared contacts dormant for **${days} days** (definition: **${def}**).

## Step 1 — Confirm the dormant definition
Show me what "dormant" will mean as a segment condition before building it:
- If \`no_open\`: no \`campaign\` opens within the last ${days} days
- If \`no_booking\`: no \`reservation.arrival_date\` within the last ${days} days
- If \`both\`: both conditions, AND'd together

Use the SendSquared playbook resource for the exact condition JSON shape.

## Step 2 — Build the segment
After I confirm the definition, call \`sendsquared_groups_create_segment\` with name like "Dormant ${days}d — re-engagement target". Then \`sendsquared_contacts_list\` with the new groupId to count members.

## Step 3 — Report and offer next step
Tell me the segment id, member count, and a sample of recent dormant contacts. Then ask whether I want to:
  (a) Build a re-engagement workflow (offer to invoke the \`drip_campaign\` flow with audience pre-filled), OR
  (b) Send a one-shot re-engagement campaign (offer to create one with \`sendsquared_campaigns_create\` then \`_send\`), OR
  (c) Stop here and let me decide later in the SendSquared web app.

## Invariants
- Do NOT send any re-engagement campaign without my explicit approval of the email content, the target segment, and the audience size.
- Surface the audience size BEFORE asking me to confirm a send — re-engagement campaigns can hit large audiences and accidentally double-mail.`
  },
}

const campaignPostmortem: PromptDefinition = {
  name: "campaign_postmortem",
  description:
    "Pull a SendSquared campaign and its report, compare to account-wide averages, and generate a plain-English performance analysis with concrete next-step recommendations.",
  arguments: [
    arg("campaign_id", "The id of the campaign to analyze", false),
  ],
  render: (args) => {
    const id = get(args, "campaign_id")
    return `Generate a performance post-mortem for SendSquared campaign ${id ? `**${id}**` : "(ask me which campaign — call sendsquared_campaigns_list and show me the 10 most recent)"}.

## Step 1 — Pull data in parallel
Make these calls in a single response (parallel tool calls):
- \`sendsquared_campaigns_get\` with the campaign id
- \`sendsquared_campaigns_report\` with the campaign id (use type=email for email campaigns; check the campaign type from the first call)
- \`sendsquared_reports_email\` with from/to (last 30 days) for account-wide email revenue baselines

## Step 2 — Analyze
Build a markdown table showing:
- Campaign metadata: name, subject, send date, audience size, channel
- Delivery: delivered, bounced, bounce rate
- Engagement: opens (count + rate), clicks (count + rate), CTR
- Outcomes: unsubscribes, spam complaints, revenue or conversions if present
- **Comparison to account averages** for open rate, CTR, bounce rate, unsub rate

## Step 3 — Call out anomalies
Flag anything that's >2x worse than the account average, or >50% better than the account average. Common anomalies:
- High bounce rate → list quality issue, suggest list cleanup
- Low open rate → subject line or sender reputation issue
- High unsubscribe rate → audience mismatch or message frequency too high
- Low CTR with high open rate → content/CTA issue

## Step 4 — Recommend next steps
Suggest 1-3 concrete actions, each as a tool invocation if possible:
- Re-send to non-openers? Build a segment via \`sendsquared_groups_create_segment\` filtered to \`campaign / opened / equal / false\` for this campaign id
- Build a segment of clickers for follow-up? Same pattern with \`clicked / equal / true\`
- Drip the engaged subset? Suggest invoking \`drip_campaign\` with audience pre-filled

## Format
Keep the report tight. Tables for numbers, prose for the recommendations. Don't dump raw JSON — interpret it.`
  },
}

const gapNightFiller: PromptDefinition = {
  name: "gap_night_filler",
  description:
    "Detect SendSquared gap nights (short windows of future availability between reservations) and propose / build a targeted campaign to fill them.",
  arguments: [
    arg("days_lookahead", "How many days to look ahead for gap nights (default: 14, max: 30)", false),
  ],
  render: (args) => {
    const days = get(args, "days_lookahead", "14")
    return `Find SendSquared gap nights in the next **${days} days** and propose a campaign to fill them.

## Step 1 — Detect gaps
Call \`sendsquared_reservations_gap_nights\` with daysInFuture=${days}. Report what came back: which units have gaps, what date ranges, how many nights total.

## Step 2 — Identify a target audience
Suggest a segment that's likely to convert on a gap-night offer:
- Past guests at properties with the gaps (\`reservation\` conditions filtered to those units)
- Geographic proximity (if SendSquared tracks contact state/zip)
- Last-minute bookers (segment of contacts whose past reservations had short lead times)

Show me the proposed segment conditions JSON. Wait for me to confirm.

## Step 3 — Build the campaign
After I confirm the segment:
1. \`sendsquared_groups_create_segment\` for the audience
2. Show me draft SMS text and/or email subject + body. Keep SMS under 160 chars.
3. If I approve the copy:
   a. \`sendsquared_sms_templates_list\` to see if a similar template exists, OR
   b. Manually compose if there's nothing reusable
   c. \`sendsquared_campaigns_create\` with name, channel, template, target group
4. **STOP before sending.** Show me the audience size and ask explicitly: "Send to N contacts? yes / no"
5. Only on explicit yes: \`sendsquared_campaigns_send\`

## Invariants
- Never send a gap-night campaign without showing the user the audience size and the message body first
- Gap-night offers tend to go out fast and across multiple channels — be extra careful about double-targeting
- If the gap is < 48 hours away, recommend SMS over email (open rates are too slow for email at that lead time)`
  },
}

const healthCheck: PromptDefinition = {
  name: "health_check",
  description:
    "Run SendSquared connectivity and configuration diagnostics. Useful when something seems wrong and you want to narrow down whether it's auth, the API, or a tool-level issue.",
  arguments: [],
  render: () => {
    return `Run a SendSquared health check.

## Step 1 — Identity and connectivity
Call these in parallel:
- \`sendsquared_doctor\` (verifies token, reports the authenticated user, pings /v1/version)
- \`sendsquared_version\` (independent reachability check)
- \`sendsquared_reservations_count\` (sanity-check that real data is reachable, not just the auth surface)

## Step 2 — Report
Summarize:
- Authenticated user (email) and company
- API URL and connectivity status
- Total reservation count (proves data plane works)
- Any non-OK results

## Step 3 — Suggest fixes
If anything failed:
- Token issue → tell me to run \`sendsquared auth login && sendsquared auth token\` and re-paste / reconnect
- Connectivity issue → suggest checking the SendSquared status page or my network
- Data plane issue → flag for investigation, the auth layer is fine but something behind it isn't

Keep the output to a short bulleted summary. Don't dump JSON.`
  },
}

const preArrival: PromptDefinition = {
  name: "pre_arrival",
  description:
    "Build a pre-arrival communication workflow: area guide email 7 days before check-in, " +
    "check-in instructions SMS 1 day before, and optional upsell offers. Triggered by arrival_date.",
  arguments: [
    arg("days_before_email", "Days before arrival to send the area guide email (default: 7)", false),
    arg("days_before_sms", "Days before arrival to send check-in SMS (default: 1)", false),
    arg("include_upsell", "If 'true', add an upsell offer email 3 days before arrival", false),
  ],
  render: (args) => {
    const emailDays = get(args, "days_before_email", "7")
    const smsDays = get(args, "days_before_sms", "1")
    const upsell = get(args, "include_upsell").toLowerCase() === "true"
    return `Build a pre-arrival communication workflow for SendSquared.

## What to build
A time-based workflow triggered by \`arrival_date\` that sends:
1. **Area guide email** — ${emailDays} days before check-in. Useful local info, restaurant recommendations, activity ideas.
2. ${upsell ? `**Upsell offer email** — 3 days before check-in. Early check-in, late checkout, add-on experiences.\n3. ` : ""} **Check-in instructions SMS** — ${smsDays} day(s) before check-in. Door codes, WiFi, parking, emergency contact.

## Steps
1. Call \`sendsquared_workflows_trigger_types\` to confirm \`time_based\` trigger with \`arrival_date\` is available.
2. Call \`sendsquared_email_templates_list\` (limit 50) to find existing pre-arrival templates. If none exist, plan to create them.
3. Call \`sendsquared_sms_templates_list\` (limit 50) for check-in SMS templates.
4. Draft the workflow steps array:
   - Wait step calculated to fire ${emailDays} days before arrival
   - Email step (area guide)
${upsell ? `   - Wait step to 3 days before arrival\n   - Email step (upsell offer)\n` : ""}   - Wait step to ${smsDays} day(s) before arrival
   - SMS step (check-in instructions)
5. **Show me the full plan before creating anything.** Include the trigger config, steps array, and which templates to use or create.
6. After approval: create any needed templates with \`sendsquared_email_templates_create\`, then \`sendsquared_workflows_create\` with the steps.
7. Ask whether to activate immediately.

## Important
- The trigger should be \`time_based\` with \`trigger_value: "arrival_date"\` — this fires relative to the guest's check-in date, not a fixed calendar date.
- Check-in SMS should be short (under 160 chars) and include only essential info. The actual door codes/WiFi should come from a merge token if available, or the user can fill them in on the template.
- Never activate the workflow without explicit user approval.`
  },
}

const postStayReview: PromptDefinition = {
  name: "post_stay_review",
  description:
    "Set up an automated post-stay review request: SMS 24 hours after checkout, " +
    "email follow-up 5 days later if no response. Highest-ROI automation per message sent.",
  arguments: [
    arg("hours_after_checkout", "Hours after checkout to send the first SMS (default: 24)", false),
    arg("followup_days", "Days after SMS to send the email follow-up (default: 5)", false),
    arg("review_url", "URL to your review page (Google, TripAdvisor, direct, etc.)", false),
  ],
  render: (args) => {
    const hours = get(args, "hours_after_checkout", "24")
    const followupDays = get(args, "followup_days", "5")
    const reviewUrl = get(args, "review_url", "(ask the user)")
    return `Build a post-stay review request workflow for SendSquared.

## Goal
Automate review solicitation after checkout. SMS first (98% open rate), email follow-up for non-responders.

## Trigger
\`time_based\` trigger with \`trigger_value: "departure_date"\`. Fires relative to checkout.

## Steps
1. **Wait** — ${hours} hours after departure
2. **SMS** — short, personal: "Hi {{contact.first_name}}, we hope you loved your stay! Would you take 30 seconds to leave us a review? ${reviewUrl !== "(ask the user)" ? reviewUrl : "[review_url]"}"
3. **Wait** — ${followupDays} days
4. **Email** — longer, with property photos, a thank-you message, and the review link as a prominent CTA button. Add a condition: only send if the SMS wasn't clicked (if click tracking is available) or send unconditionally as a reminder.

## Execution
1. Call \`sendsquared_workflows_trigger_types\` to confirm departure_date trigger availability.
2. Check for existing review templates: \`sendsquared_email_templates_list\` and \`sendsquared_sms_templates_list\`.
3. If the user hasn't provided a review URL, ask for it now — we need it for the SMS and email CTA.
4. Draft the workflow and show it to the user.
5. After approval: create templates if needed, then \`sendsquared_workflows_create\`.
6. Ask whether to activate and whether to run for recent checkouts via \`sendsquared_workflows_run_existing\`.

## SMS compliance
- Post-stay review requests are generally **transactional** (related to a completed booking), not marketing. They can be sent without explicit marketing SMS opt-in in most jurisdictions.
- Keep the SMS under 160 characters.
- Still respect quiet hours — don't send review requests at 2am.`
  },
}

const otaToDirect: PromptDefinition = {
  name: "ota_to_direct",
  description:
    "Find guests who booked via OTAs (Airbnb, VRBO, Booking.com) but never booked direct. " +
    "Build a 'book direct and save' campaign to convert them.",
  arguments: [
    arg("ota_sources", "Comma-separated OTA source names to target (default: Airbnb,VRBO,Booking.com)", false),
    arg("promo_code", "Promo code to offer for direct booking (optional)", false),
    arg("discount_pct", "Discount percentage to advertise (e.g. '15')", false),
  ],
  render: (args) => {
    const sources = get(args, "ota_sources", "Airbnb,VRBO,Booking.com")
    const promo = get(args, "promo_code")
    const discount = get(args, "discount_pct", "15")
    return `Find OTA guests and build a direct booking conversion campaign.

## Why this matters
Every guest converted from OTA to direct booking saves 15-20% in commission fees. These guests already love the property — they just need a reason to book direct next time.

## Step 1 — Build the "OTA guests, never booked direct" segment
Use the segment-first pattern:
- Block 1: reservation.source IN (${sources.split(",").map(s => s.trim()).join(", ")}) — guests who've booked via an OTA
- Block 2: reservation.source NOT EQUAL "direct" (or whatever the direct source label is — call \`sendsquared_groups_condition_config\` to confirm available source values)

The segment logic: guests who HAVE an OTA reservation AND do NOT have a direct reservation. This requires segment composition — build "has direct booking" as a separate segment, then exclude it from the OTA segment using \`segment / segment_id / notEqual\`.

**Show me the segment plan before creating anything.**

## Step 2 — Report the opportunity
After creating the segment, \`sendsquared_contacts_list\` with the groupId. Report:
- Total contacts in the segment
- Sample of 10 with their reservation history (how many OTA stays, total revenue)
- Estimated commission savings if ${discount}% convert to direct

## Step 3 — Build the campaign
Draft an email with:
- Subject: "Skip the fees — book direct and save ${discount}%"
- Personal greeting using {{contact.first_name}}
- Acknowledge their past stay(s): "You've stayed with us X times through [OTA]..."
- Value proposition: direct booking = best price guarantee, no service fees, direct communication
${promo ? `- Promo code: **${promo}**\n` : "- Ask the user for a promo code or booking link to include\n"}- Clear CTA button linking to the direct booking page

Create the template with \`sendsquared_email_templates_create\`, then wire it into a campaign targeting the segment. **Confirm before sending.**

## Invariants
- This is a marketing email — recipients must be email-opted-in. Add that condition to the segment if needed.
- Don't badmouth the OTA ("Airbnb is expensive"). Frame it positively ("book direct for the best experience").`
  },
}

const revenueReport: PromptDefinition = {
  name: "revenue_report",
  description:
    "Generate a revenue report for a date range: total revenue, ADR, occupancy, " +
    "breakdown by month/unit, comparison to prior period. Uses reservation pagination.",
  arguments: [
    arg("start_date", "Report start date, YYYY-MM-DD", true),
    arg("end_date", "Report end date, YYYY-MM-DD", true),
    arg("compare_prior", "If 'true', also pull the same-length prior period for comparison", false),
  ],
  render: (args) => {
    const start = get(args, "start_date")
    const end = get(args, "end_date")
    const compare = get(args, "compare_prior").toLowerCase() === "true"
    return `Generate a revenue report for **${start} to ${end}**${compare ? " with prior-period comparison" : ""}.

## Data collection (Category B — reservation pagination)
This is a reservation-level query, not a contact query. Do NOT create a segment.

1. Paginate \`sendsquared_reservations_list\` with filters:
   - \`arrival_date:gte:${start}\`
   - \`arrival_date:lte:${end}\`
   - Limit 1000 per page, cursor via \`after_id\`
   - Include \`contact=true\` for guest details
2. Accumulate ALL matching reservations across pages.
3. **Exclude cancelled reservations** from revenue calculations (filter by \`status\` — include confirmed, checked_in, checked_out only).
${compare ? `4. Repeat for the prior period: calculate the same date range length and shift backward. For example, if the range is 90 days, pull the 90 days immediately before ${start}.\n` : ""}
## Metrics to compute
From the collected reservations, calculate:

| Metric | Formula |
|---|---|
| **Total revenue** | sum(total_revenue) across non-cancelled reservations |
| **Room revenue** | sum(room_revenue) |
| **ADR** (Average Daily Rate) | sum(room_revenue) / sum(nights) |
| **Total nights booked** | sum(nights) |
| **Average stay length** | sum(nights) / count(reservations) |
| **Reservations count** | count of non-cancelled reservations |
| **Revenue per reservation** | total_revenue / count |

If the user's total unit count is known (ask if not), also calculate:
| **Occupancy rate** | sum(nights) / (total_units × days_in_period) |
| **RevPAR** | room_revenue / (total_units × days_in_period) |

## Breakdown
Show a table broken down by **month** (if the range spans multiple months) with the same metrics per month.

If reservations include unit/property info, also show a breakdown by **unit type** or **property**.

${compare ? `## Prior period comparison
Show current vs prior side by side with % change for each metric. Flag anything that moved more than 20% in either direction.\n` : ""}
## Format
- Use markdown tables for the numbers
- **Show your math**: state how many reservations you included, which statuses, which field you summed
- Bold any metric that looks unusual (ADR > 2x or < 0.5x the overall average, occupancy > 95% or < 30%)
- End with 2-3 actionable observations ("ADR is up 12% but occupancy dropped — consider targeted shoulder-season pricing")`
  },
}

const contactCleanup: PromptDefinition = {
  name: "contact_cleanup",
  description:
    "Find and review duplicate contacts for potential merging. Searches for common " +
    "dupe patterns (same email, same phone, similar names) and presents pairs for user review.",
  arguments: [
    arg("strategy", "Dupe detection strategy: 'email' (same email), 'phone' (same phone), 'name' (similar name). Default: email", false),
    arg("limit", "Maximum number of potential dupe pairs to surface (default: 20)", false),
  ],
  render: (args) => {
    const strategy = get(args, "strategy", "email")
    const limit = get(args, "limit", "20")
    return `Find and review duplicate contacts in SendSquared.

## Strategy: ${strategy}
${strategy === "email" ? "Search for contacts sharing the same email address. These are almost always true duplicates (same person, booked through different channels or at different times)." : ""}${strategy === "phone" ? "Search for contacts sharing the same phone number but different email addresses. These are likely the same person with multiple email addresses." : ""}${strategy === "name" ? "Search for contacts with very similar names (same first+last, different email). Higher false-positive rate — present carefully." : ""}

## Approach
This requires iterating through contacts because SendSquared doesn't have a built-in dedup endpoint.

1. Call \`sendsquared_contacts_list\` with a high limit (100 per page), paginate through contacts.
2. Build an in-memory index keyed by ${strategy === "email" ? "email address" : strategy === "phone" ? "phone number" : "normalized name (lowercase, trimmed)"}.
3. Identify keys with more than one contact — these are the dupe candidates.
4. Stop after finding ${limit} potential dupe pairs (don't scan the entire database — surface early wins first).

## Presentation
For each dupe pair, show a side-by-side comparison:
| Field | Contact A | Contact B |
|---|---|---|
| ID | ... | ... |
| Name | ... | ... |
| Email | ... | ... |
| Phone | ... | ... |
| Source | ... | ... |
| Reservation count | (call \`sendsquared_reservations_by_contact\` for each) | ... |
| Last activity | ... | ... |

Recommend which should be the primary (the one with more reservations or more recent activity).

## Merging
**NEVER merge without explicit user approval for each pair.** Present all pairs first, let the user say "merge pair 1, 3, and 5" (or "merge all"), then call \`sendsquared_contacts_merge\` for each approved pair.

After merging, report what was done: "Merged 5 pairs, X contacts removed, Y reservations consolidated."

## Invariants
- Merging is irreversible. Say this clearly.
- If the PMS handles dedup, suggest the user do it there instead — the next sync might re-create dupes we just merged.
- Don't scan more than 500 contacts without asking — large accounts could have thousands and the scan would be slow.`
  },
}

const bookingPace: PromptDefinition = {
  name: "booking_pace",
  description:
    "Compare current future bookings to the same period last year. " +
    "Shows whether the property is ahead or behind on reservations and revenue.",
  arguments: [
    arg("days_ahead", "How many days into the future to look (default: 90)", false),
  ],
  render: (args) => {
    const days = get(args, "days_ahead", "90")
    return `Generate a booking pace report: current future bookings vs. same period last year.

## What "booking pace" means
On this date last year, how many reservations and how much revenue was on the books for the next ${days} days? Compare that to what's on the books right now for the next ${days} days. The difference tells you whether you're ahead or behind.

## Data collection (reservation pagination — Category B)
1. **Current pace**: paginate \`sendsquared_reservations_list\` with:
   - \`arrival_date:gte:TODAY\` (substitute actual date)
   - \`arrival_date:lte:TODAY+${days}d\` (substitute actual date)
   - Exclude cancelled
   Compute: count, total_revenue, room_revenue, total_nights

2. **Prior year pace**: paginate with:
   - \`arrival_date:gte:LASTYEAR_TODAY\` (substitute actual date)
   - \`arrival_date:lte:LASTYEAR_TODAY+${days}d\` (substitute actual date)
   - Exclude cancelled
   Same metrics.

Calculate the dates explicitly (e.g. if today is 2026-04-10 and days=90, current window is 2026-04-10 to 2026-07-09, prior year is 2025-04-10 to 2025-07-09).

## Report format

| Metric | This year | Last year | Change |
|---|---|---|---|
| Reservations | ... | ... | +/-% |
| Total revenue | ... | ... | +/-% |
| Room revenue | ... | ... | +/-% |
| Nights booked | ... | ... | +/-% |
| ADR | ... | ... | +/-% |

Then break down by **month** within the window.

## Interpretation
- **Ahead on reservations but behind on revenue** → ADR is lower, maybe too many discounts or shorter stays
- **Behind on reservations but ahead on revenue** → fewer but higher-value bookings, could be fine
- **Behind on both** → suggest a targeted campaign (use \`dormant_reengagement\` or \`gap_night_filler\`)
- **Ahead on both** → suggest focusing on upsells and experience add-ons rather than discounts

End with 2-3 specific action recommendations tied to the data.`
  },
}

const seasonalPlanner: PromptDefinition = {
  name: "seasonal_planner",
  description:
    "Generate a 90-day campaign calendar based on the current date, the user's market type, " +
    "and their actual booking data. Ties seasonal knowledge to real account metrics.",
  arguments: [
    arg("market_type", "Property market: beach, mountain, ski, urban, lake, desert, tropical (or ask user)", false),
    arg("days_ahead", "Planning horizon in days (default: 90)", false),
  ],
  render: (args) => {
    const market = get(args, "market_type", "(ask the user)")
    const days = get(args, "days_ahead", "90")
    return `Generate a ${days}-day campaign calendar for a **${market}** vacation rental market.

## Step 1 — Understand the current state
Run these in parallel:
- \`sendsquared_reports_analytics\` — call dashboard metrics; \`sendsquared_reports_run\` (see \`sendsquared_reports_types\`) for any Reports-screen report
- \`sendsquared_reservations_count\` — total reservations
- \`sendsquared_campaigns_list\` (limit 10) — recent campaign activity
- \`sendsquared_groups_list\` — existing segments
- \`sendsquared_workflows_list\` — existing automations

Also call the \`booking_pace\` analysis mentally: are bookings ahead or behind vs. last year? Use \`sendsquared_reservations_list\` with a ${days}-day forward window and compare to last year's same window.

## Step 2 — Determine seasonal context
${market !== "(ask the user)" ? `For a **${market}** market, ` : "Ask the user their market type, then "}reference the seasonal patterns in the SendSquared playbook:
- What season are we in right now (high, shoulder, off)?
- What season is coming in the next ${days} days?
- What should the messaging focus be (discounts vs. upsells vs. re-engagement)?

## Step 3 — Build the calendar
Produce a markdown table:

| Week | Campaign/Workflow | Type | Target Segment | Goal |
|---|---|---|---|---|
| Week 1 | ... | Email/SMS/Workflow | ... | ... |
| Week 2 | ... | ... | ... | ... |
| ... | ... | ... | ... | ... |

Each entry should reference:
- An existing segment (by name) or describe a new one to build
- An existing template or describe content to create
- Whether it's a one-shot campaign or an ongoing workflow

## Step 4 — Prioritize
Rank the calendar entries by estimated impact. The top 3 should be executable this week. For each of the top 3, offer to build them right now (invoke \`drip_campaign\`, \`gap_night_filler\`, \`dormant_reengagement\`, or \`ota_to_direct\` as appropriate).

## What NOT to do
- Don't suggest 15 campaigns for a small operator — 4-6 for the period is realistic
- Don't plan campaigns for seasons that aren't in the ${days}-day window
- If bookings are strong, don't push discounts — suggest upsells and experience-focused content instead
- If the user doesn't tell you their market type, ASK — don't guess. Beach and ski have opposite seasonality.`
  },
}

const cancellationWinback: PromptDefinition = {
  name: "cancellation_winback",
  description:
    "Find recently cancelled reservations and build a rebooking incentive campaign. " +
    "Many cancellations are soft (date flexibility, price sensitivity) and recoverable.",
  arguments: [
    arg("days_back", "How many days back to look for cancellations (default: 30)", false),
    arg("offer_type", "Incentive type: 'discount', 'flexible_dates', 'upgrade', or 'none'. Default: flexible_dates", false),
  ],
  render: (args) => {
    const days = get(args, "days_back", "30")
    const offer = get(args, "offer_type", "flexible_dates")
    return `Build a cancellation winback campaign for the last ${days} days.

## Step 1 — Find cancelled reservations
Paginate \`sendsquared_reservations_list\` with:
- \`status:eq:cancelled\` (or whatever the cancellation status value is — check a few reservations first to find the exact string)
- \`arrival_date:gte:YYYY-MM-DD\` (substitute the date for ${days} days ago — recently cancelled, not ancient history)
- Include contact details (\`include_contact=true\`)

Report: total cancelled, total lost revenue, average booking value, breakdown by cancellation timing (how far before arrival).

## Step 2 — Build the target segment
Create a segment of contacts who had a cancellation in the last ${days} days. Use:
- \`reservation\` condition type with \`status = cancelled\` and recent date range

**BUT ALSO** exclude contacts who have subsequently rebooked:
- Build a "has future booking" segment first (reservation.arrival_date >= today)
- Exclude it from the cancellation segment via segment composition

Show me the segment plan before creating.

## Step 3 — Design the outreach
${offer === "discount" ? "Offer a percentage discount on rebooking within 30 days. Draft email with urgency (limited-time offer)." : ""}${offer === "flexible_dates" ? "Emphasize date flexibility: 'We understand plans change. Pick new dates that work for you — no rebooking fees.' Low cost to the operator, removes friction." : ""}${offer === "upgrade" ? "Offer a room/unit upgrade at the same price: 'Come back and we'll upgrade you.' Works when you have larger units with availability." : ""}${offer === "none" ? "Simple 'we miss you' outreach — remind them what they're missing without a specific offer. Include property photos and recent reviews." : ""}

Draft both an **email** (detailed, with property photos and CTA) and an **SMS** (short, personal, links to booking page).

## Step 4 — Execute
1. Create the segment
2. Create email + SMS templates
3. For high-value cancellations (top 20% by revenue): suggest SMS first (personal touch, immediate delivery)
4. For the rest: email campaign
5. **Confirm audience size and message content before sending anything**

## Timing matters
- Cancellations < 7 days old: best recovery rate. Prioritize these.
- Cancellations 7-14 days old: still recoverable, especially with an incentive.
- Cancellations > 14 days old: low recovery rate but worth a try for high-value bookings.
Consider segmenting by recency and tailoring the urgency of the message accordingly.`
  },
}

const guidebookBuilder: PromptDefinition = {
  name: "guidebook_builder",
  description:
    "Build a complete SendSquared digital guidebook for a property — either from scratch or by " +
    "adding blocks to an existing guidebook. Can auto-discover top restaurants, activities, and " +
    "local attractions in the area and create blocks for each.",
  arguments: [
    arg("location", "City, neighborhood, or address of the property (e.g. 'Outer Banks, NC' or '123 Beach Rd, Kill Devil Hills, NC')", true),
    arg("guidebook_id", "Existing guidebook id to add blocks to. If omitted, a new guidebook is created.", false),
    arg("guidebook_name", "Name for a new guidebook (ignored if guidebook_id is provided)", false),
    arg("block_types", "Comma-separated block types to populate: restaurants, activities, area, house_access, house_guides, all. Default: all", false),
    arg("count", "How many of each type to create (default: 10 for restaurants/activities, 1 for house guides)", false),
  ],
  render: (args) => {
    const location = get(args, "location", "(ask the user)")
    const guidebookId = get(args, "guidebook_id")
    const guidebookName = get(args, "guidebook_name")
    const blockTypes = get(args, "block_types", "all")
    const count = get(args, "count", "10")
    return `Build a SendSquared guidebook for a property in \`${location}\`.
${guidebookId ? `Adding to existing guidebook \`${guidebookId}\`.` : `Creating a new guidebook${guidebookName ? ` named \`${guidebookName}\`` : ""}.`}
Block types to populate: \`${blockTypes}\`
Count per category: \`${count}\`

## Step 1 — Guidebook setup
${guidebookId
  ? `Call \`sendsquared_guidebooks_get\` with id ${guidebookId} to see what's already in it.`
  : `Call \`sendsquared_guidebooks_create\` with:
  - name: ${guidebookName || `"${location} Guest Guide"`}
  - active: true
  - access_days_before: 7 (guests can view 7 days before check-in)
  - access_days_after: 3 (stays visible 3 days after checkout)
  - pdf_exportable: true`
}

## Step 2 — Research local recommendations

Using your knowledge of \`${location}\`, compile lists of:

${blockTypes === "all" || blockTypes.includes("restaurants") ? `### Restaurants (${count} total)
For each restaurant, gather:
- Name (goes in \`public_name\`)
- Cuisine type and why it's notable (goes in \`description\` — write 2-3 engaging sentences from a local's perspective)
- Full street address (\`address_1\`, \`locality\`, \`region\`, \`postal_code\`)
- Phone number if known
- Website URL (\`external_link\`)
- Google Places ID if you can determine it from the name + address

Prioritize: local favorites over chains, variety of cuisines, different price points, and places within a reasonable drive of the property.
` : ""}
${blockTypes === "all" || blockTypes.includes("activities") ? `### Activities & attractions (${count} total)
Same format but with \`guidebook_block_type: "activityGuides"\`. Include beaches, parks, tours, water sports, hiking, shopping, museums — whatever the area is known for.
` : ""}
${blockTypes === "all" || blockTypes.includes("area") ? `### Area guide (1-2 blocks)
A general "Welcome to ${location}" block with \`guidebook_block_type: "areaGuides"\`. Describe the vibe, what makes the area special, best seasons to visit, general tips.
` : ""}
${blockTypes === "all" || blockTypes.includes("house_access") ? `### House access (1 block)
A \`houseAccess\` block with placeholder text: "Check-in instructions will be sent 24 hours before your arrival." The property manager will fill in the actual door codes/WiFi.
` : ""}
${blockTypes === "all" || blockTypes.includes("house_guides") ? `### House guides (1-2 blocks)
A \`houseGuides\` block with common house rules: quiet hours, trash pickup schedule, parking, pool rules. Use generic best-practice content that the property manager can customize.
` : ""}

## Step 3 — Show the plan

Before creating anything, present the full list as a table:

| # | Type | Public Name | Description (first 50 chars) | Address |
|---|---|---|---|---|
| 1 | restaurantGuides | The Blue Point | Fresh seafood with waterfront views... | 1240 Duck Rd, Duck, NC |
| ... | ... | ... | ... | ... |

Ask the user: "Create all ${count}+ blocks and add to the guidebook? Or modify the list first?"

## Step 4 — Create blocks in batch

After user approval, call \`sendsquared_guidebook_blocks_create_batch\` with:
- \`guidebookId\`: the guidebook id (from step 1)
- \`blocks\`: the full array of block definitions

This creates all blocks in one call and auto-adds them to the guidebook.

## Step 5 — Confirm and suggest next steps

After creation, call \`sendsquared_guidebooks_get\` to verify all blocks are in the guidebook. Report the total block count and suggest:
- Assign the guidebook to properties: \`sendsquared_guidebooks_assign_units\`
- Reorder blocks if needed: \`sendsquared_guidebooks_reorder_blocks\`
- Add more categories (e.g. "want me to add local activities too?")

## Important
- Write descriptions from a **local's perspective** — personal, warm, specific. Not generic travel-guide copy. "The fish tacos here are the best on the island — get there before noon on weekends or you'll wait an hour" beats "A popular seafood restaurant."
- Include **practical details** guests care about: parking situation, reservation needed?, kid-friendly?, casual vs dressy.
- Don't fabricate restaurant names. Use real places you know to exist in the area. If you're not confident about a specific restaurant in the location, say so and ask the user to confirm or fill in.
- For addresses, be as complete as you can. If you only know the city/town, that's fine — the user can add the street later.`
  },
}

const agentProductivityReportPrompt: PromptDefinition = {
  name: "agent_productivity",
  description:
    "Generate an agent performance report — who is handling the most calls/messages, who has the " +
    "best response times, who is generating the most revenue. Ranks agents from best to worst.",
  arguments: [
    arg("start_date", "Report start date YYYY-MM-DD", true),
    arg("end_date", "Report end date YYYY-MM-DD", true),
    arg("timezone", "Timezone (default: America/Chicago)", false),
  ],
  render: (args) => {
    const start = get(args, "start_date")
    const end = get(args, "end_date")
    const tz = get(args, "timezone", "America/Chicago")
    return `Generate a comprehensive agent productivity report for \`${start}\` to \`${end}\` (timezone: \`${tz}\`).

## Step 1 — Gather data (run ALL in parallel)

Call these simultaneously:
- \`sendsquared_agents_list\` — get agent names/IDs
- \`sendsquared_report_agent_productivity\` — time in each status per agent
- \`sendsquared_report_agent_booked_revenue\` — revenue per agent (values in CENTS, divide by 100)
- \`sendsquared_report_call_volume_by_agent\` — calls handled per agent
- \`sendsquared_report_sms_volume_by_agent\` — SMS handled per agent
- \`sendsquared_report_sms_response_duration\` — SMS response time per agent
- \`sendsquared_report_email_response_duration\` — email response time per agent

## Step 2 — Build the scorecard

For each agent, compile:
| Metric | What it shows |
|---|---|
| Total logged time | How many hours they were logged in |
| % busy vs % available vs % away | Are they actively working or idle? |
| Calls handled | Total inbound + outbound answered |
| SMS conversations handled | Total text threads |
| Avg SMS response time | How fast they reply to texts |
| Avg email response time | How fast they reply to emails |
| Revenue booked | Total booking revenue attributed (in dollars, not cents!) |

## Step 3 — Rank agents

Produce three rankings:
1. **Top performers** — highest call volume + lowest response times + most revenue
2. **Needs improvement** — low activity, high response times, or mostly in "away" status
3. **Revenue leaders** — sorted by booked revenue

## Step 4 — Actionable insights

For each underperforming agent, suggest a specific intervention:
- High away time → check if they need schedule adjustment or training
- Low call volume but high handle time → may be thorough but slow, could benefit from scripts
- High abandonment on their queue → understaffed during their shift, not a performance issue
- Good response time but low revenue → handling volume well but may need upsell training

Keep the tone constructive — this is a coaching tool, not a blame report.`
  },
}

const staffingAnalysisPrompt: PromptDefinition = {
  name: "staffing_analysis",
  description:
    "Analyze call and SMS volume patterns to identify when more staff is needed — " +
    "peak hours, understaffed days, abandonment spikes, and response time degradation.",
  arguments: [
    arg("start_date", "Analysis start date YYYY-MM-DD (recommend at least 2 weeks for patterns)", true),
    arg("end_date", "Analysis end date YYYY-MM-DD", true),
    arg("timezone", "Timezone (default: America/Chicago)", false),
  ],
  render: (args) => {
    const start = get(args, "start_date")
    const end = get(args, "end_date")
    const tz = get(args, "timezone", "America/Chicago")
    return `Analyze staffing needs for \`${start}\` to \`${end}\` (timezone: \`${tz}\`).

## Step 1 — Gather volume data (run ALL in parallel)

- \`sendsquared_report_call_volume_by_hour\` — when do calls peak?
- \`sendsquared_report_call_volume_by_day\` — which days are busiest?
- \`sendsquared_report_sms_volume_by_hour\` — when do texts peak?
- \`sendsquared_report_sms_volume_by_day\` — which days have the most texts?
- \`sendsquared_report_call_abandonment_summary\` — when are callers giving up?
- \`sendsquared_report_call_stats\` — queue wait times, missed call rates
- \`sendsquared_report_sms_response_duration\` — are response times spiking at certain times?
- \`sendsquared_report_agent_productivity\` — how many agents are logged in during peak vs off-peak?

## Step 2 — Identify patterns

Build a combined hourly heatmap:

| Hour | Calls | SMS | Total Load | Agents Online | Abandonments | Avg Response |
|---|---|---|---|---|---|---|
| 8am | ... | ... | ... | ... | ... | ... |
| 9am | ... | ... | ... | ... | ... | ... |
| ... | | | | | | |

Flag hours where:
- **Total load per agent > threshold** (e.g. > 10 interactions/hour/agent)
- **Abandonment rate > 10%** — callers giving up
- **SMS response time > 15 minutes** — texts piling up
- **No agents logged in** but volume exists — coverage gap

## Step 3 — Daily pattern

| Day | Peak Hour | Total Volume | Abandonments | Coverage Gap? |
|---|---|---|---|---|
| Monday | ... | ... | ... | ... |
| Tuesday | ... | ... | ... | ... |
| ... | | | | |

## Step 4 — Staffing recommendations

Based on the patterns, recommend:

1. **Peak hours that need more coverage** — "Add 1 agent between 10am-2pm on weekdays; call volume is 3x higher than staffing allows"
2. **Quiet hours where staff can be reduced** — "After 6pm volume drops 80%; consider on-call only"
3. **Weekend gaps** — "Saturday morning has consistent volume but low coverage"
4. **SMS-specific staffing** — "Text volume peaks at 3pm (guests checking in); ensure at least 1 agent is on SMS duty"
5. **Abandonment reduction** — "75% of abandoned calls happen between 11am-1pm; adding 1 agent during lunch would recover an estimated X calls/day"

## Format

Use tables and specific numbers. Don't say "consider adding staff" — say "add 1 agent from 10am-2pm Monday-Friday based on 47 abandoned calls during those hours last week." Tie every recommendation to data.`
  },
}

export const PROMPTS: PromptDefinition[] = [
  repeatGuests,
  dripCampaign,
  dormantReengagement,
  campaignPostmortem,
  gapNightFiller,
  healthCheck,
  preArrival,
  postStayReview,
  otaToDirect,
  revenueReport,
  contactCleanup,
  bookingPace,
  seasonalPlanner,
  cancellationWinback,
  guidebookBuilder,
  agentProductivityReportPrompt,
  staffingAnalysisPrompt,
]

export const PROMPT_BY_NAME = new Map(PROMPTS.map((p) => [p.name, p]))
