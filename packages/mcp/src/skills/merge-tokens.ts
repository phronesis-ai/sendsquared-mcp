/*
  The SendSquared merge-token reference. Exposed via MCP resources so the LLM
  can pull it into context when writing or editing an email/SMS template.

  Source of truth:
    - Token list: ad-base-spa/src/components/Dashboard/Views/TokenTable/tokenDef.js
      (the same catalog shown to marketers in the editor's "Tokens" panel)
    - Special URLs: ad-base-spa/src/components/Dashboard/Views/Templates/EmailEditor.vue
      (the Stripo mergetag menu — what marketers actually paste into templates)
    - Merge engine behavior: ad-base-main/src/services/contentMergeService.ts
      (WASM-based, supports only {{namespace.field}} — no filters, no conditionals)

  Keep this file in sync with those sources. If tokenDef.js adds a new token or
  EmailEditor.vue changes a short-link domain, update here too.
*/

export const MERGE_TOKENS_REFERENCE = `# SendSquared Merge Tokens & Special URLs

This is the authoritative catalog of merge tokens available to email and SMS
templates in SendSquared. Any \`{{namespace.field}}\` below will be substituted
with the contact/reservation/company value at send time.

**Engine constraints** (important):

- Syntax is \`{{namespace.field}}\` only. No filters, no conditionals, no loops,
  no Handlebars/Liquid expressions. Arrays are accessed by index (\`units.0.name\`,
  \`units.1.name\`). There is no \`{{#each}}\`.
- Tokens that aren't applicable to the current send context resolve to an empty
  string. Don't rely on tokens for layout-critical text — always have a fallback
  in the surrounding copy.
- **All monetary fields are in cents** (integer). A \`total_revenue\` of \`500000\`
  is $5,000.00. You must not display raw cents to end users — do the division in
  your copy ("your stay total was $5,000") or use a field the PMS has already
  formatted.
- Dates render as ISO 8601 strings. For human-facing dates, prefer the
  \`_local\` variants (\`arrival_date_local\`, \`departure_date_local\`) which have
  the timezone suffix stripped.
- Custom fields use dot notation: \`{{contact.custom_fields.favorite_color}}\`,
  \`{{reservation.custom_fields.referred_by}}\`, etc. Field names come from the
  company's custom-field configuration.

---

## Special URLs (use these verbatim)

These are short-link and public-webview URLs. The short-link domains
(\`ssqgo.com\`, \`sndsq.com\`) are **distinct from** the main public-webview
domain (\`list-manage.sendsquared.com\`) — do not swap them.

### Guidebook

\`\`\`
https://ssqgo.com/g/{{reservation.uuid}}
\`\`\`

Links the guest to the digital guidebook for their reservation. Guidebook
access is gated by the unit/company's \`access_days_before\` and
\`access_days_after\` windows relative to check-in/check-out — a premature or
post-window click shows a "not available" page rather than the content.

### Survey

\`\`\`
https://sndsq.com/s/g/{{survey.token}}
\`\`\`

Links the contact to their assigned survey. The token is a 10-character string
minted when the survey is assigned — requires a \`survey\` context (the send
must be associated with a \`contact_survey\` record, typically via a survey
workflow step or a survey-triggered campaign).

### Unsubscribe

\`\`\`
https://list-manage.sendsquared.com/v1/pub/unsubscribe?id={{contact.id}}&token={{contact.unsubscribe_token}}&unsub_type=campaign&unsub_id={{campaign.id}}
\`\`\`

Required in the footer of every marketing email. \`unsub_type\` + \`unsub_id\`
let the platform record *which* send the unsubscribe came from so the
deliverability team can attribute complaints.

### Manage preferences

\`\`\`
https://list-manage.sendsquared.com/v1/pub/manage/{{company.uuid}}/{{contact.id}}/{{contact.unsubscribe_token}}
\`\`\`

A more granular alternative to unsubscribe — lets the contact pick which
categories they stay subscribed to. Recommended alongside the unsubscribe link
in every footer.

### View in browser (campaign archive)

\`\`\`
https://list-manage.sendsquared.com/v1/pub/archive/{{company.uuid}}/{{campaign.id}}?token={{contact.unsubscribe_token}}
\`\`\`

Opens the rendered email in a web view. Useful for clients with broken image
loading or for contacts who want to share the email.

---

## Merge-token namespaces

Each namespace fills from a different source. Tokens only resolve when their
namespace is in scope for the send — e.g. \`reservation.*\` tokens need a
reservation-anchored context (a workflow step attached to a reservation event,
or a campaign that targets a reservation-derived segment).

### contact

Recipient identity — available in every send.

| Token | Meaning |
|---|---|
| \`{{contact.id}}\` | Contact ID |
| \`{{contact.first_name}}\` | First name |
| \`{{contact.last_name}}\` | Last name |
| \`{{contact.email}}\` | Primary email address |
| \`{{contact.mobile_phone}}\` | Mobile phone |
| \`{{contact.home_phone}}\` | Home phone |
| \`{{contact.address_1}}\` | Street address line 1 |
| \`{{contact.address_2}}\` | Street address line 2 |
| \`{{contact.locality}}\` | City |
| \`{{contact.region}}\` | State / region |
| \`{{contact.postal}}\` | Postal / ZIP |
| \`{{contact.country}}\` | Country |
| \`{{contact.locale}}\` | Language / locale code |
| \`{{contact.timezone}}\` | Timezone |
| \`{{contact.birthday}}\` | Birthday (ISO date) |
| \`{{contact.anniversary}}\` | Anniversary (ISO date) |
| \`{{contact.verified_at}}\` | Email verification timestamp |
| \`{{contact.created_at}}\` | Contact created timestamp |
| \`{{contact.modified_at}}\` | Contact last-modified timestamp |
| \`{{contact.company_id}}\` | Company ID (owner account) |
| \`{{contact.company_name}}\` | Contact's company name |
| \`{{contact.display_name}}\` | Display name override |
| \`{{contact.contact_type}}\` | Contact type |
| \`{{contact.source}}\` | Acquisition source |
| \`{{contact.external_id}}\` | External / connector ID |
| \`{{contact.place_id}}\` | Google Place ID |
| \`{{contact.engagement}}\` | Engagement score |
| \`{{contact.email_validated}}\` | Email validation flag |
| \`{{contact.dont_send_email}}\` | Email suppression flag |
| \`{{contact.dont_send_sms}}\` | SMS suppression flag |
| \`{{contact.unsubscribe_token}}\` | Token for unsubscribe / manage URLs |
| \`{{contact.last_sent_email}}\` | Last email send timestamp |
| \`{{contact.last_sent_sms}}\` | Last SMS send timestamp |
| \`{{contact.last_open_email}}\` | Last email open timestamp |
| \`{{contact.last_open_sms}}\` | Last SMS open timestamp |
| \`{{contact.last_click_email}}\` | Last email click timestamp |
| \`{{contact.last_received_email}}\` | Last inbound email timestamp |
| \`{{contact.last_received_sms}}\` | Last inbound SMS timestamp |
| \`{{contact.email_send_time}}\` | Preferred send-time slot |
| \`{{contact.custom_fields.FIELD_NAME}}\` | Any custom contact field |

### company

Sender / owning-company identity — available in every send.

| Token | Meaning |
|---|---|
| \`{{company.name}}\` | Legal / DBA name |
| \`{{company.uuid}}\` | Company UUID (needed for manage + archive URLs) |
| \`{{company.address_1}}\` | Street address line 1 |
| \`{{company.address_2}}\` | Street address line 2 |
| \`{{company.locality}}\` | City |
| \`{{company.region}}\` | State / region |
| \`{{company.postal}}\` | Postal / ZIP |
| \`{{company.country}}\` | Country |
| \`{{company.locale}}\` | Locale |
| \`{{company.language}}\` | Preferred language |
| \`{{company.timezone}}\` | Timezone |
| \`{{company.company_logo}}\` | Logo URL |
| \`{{company.email_disabled}}\` | Global email suppression flag |
| \`{{company.sms_disabled}}\` | Global SMS suppression flag |
| \`{{company.email_disabled_reason}}\` | Reason email is suppressed |
| \`{{company.sms_disabled_reason}}\` | Reason SMS is suppressed |
| \`{{company.created_at}}\` | Company record created |
| \`{{company.modified_at}}\` | Company last-modified |

### campaign

Current campaign metadata — available in campaign sends.

| Token | Meaning |
|---|---|
| \`{{campaign.id}}\` | Campaign ID (needed for unsubscribe + archive URLs) |
| \`{{campaign.name}}\` | Campaign name |
| \`{{campaign.is_archive}}\` | Archived flag |
| \`{{campaign.fire_at}}\` | Scheduled send time |
| \`{{campaign.created_at}}\` | Campaign created |
| \`{{campaign.modified_at}}\` | Campaign last-modified |

### reservation

Booking-scoped tokens — only available when the send is anchored to a
reservation (workflow triggered by a reservation event, or a reservation-based
campaign). All monetary fields are **cents**.

| Token | Meaning |
|---|---|
| \`{{reservation.uuid}}\` | Reservation UUID (needed for guidebook URL) |
| \`{{reservation.pms_id}}\` | PMS-side ID |
| \`{{reservation.reservation_number}}\` | Human-readable booking number |
| \`{{reservation.confirmation_code}}\` | Confirmation code |
| \`{{reservation.external_id}}\` | Third-party external ID |
| \`{{reservation.connector_id}}\` | Integration connector ID |
| \`{{reservation.status}}\` | Status (confirmed / cancelled / checked_in / …) |
| \`{{reservation.reservation_type}}\` | Reservation type |
| \`{{reservation.source}}\` | Booking source |
| \`{{reservation.external_source}}\` | External source name |
| \`{{reservation.source_of_business}}\` | Source category |
| \`{{reservation.market_code}}\` | Market code |
| \`{{reservation.adults}}\` | Adult headcount |
| \`{{reservation.children}}\` | Child headcount |
| \`{{reservation.pets}}\` | Pet headcount |
| \`{{reservation.nights}}\` | Nights booked |
| \`{{reservation.total_revenue}}\` | Total revenue **(cents)** |
| \`{{reservation.room_revenue}}\` | Room-rate revenue **(cents)** |
| \`{{reservation.extra_revenue}}\` | Extras / fees revenue **(cents)** |
| \`{{reservation.taxes}}\` | Tax amount **(cents)** |
| \`{{reservation.deposit}}\` | Deposit **(cents)** |
| \`{{reservation.arrival_date}}\` | Arrival date (ISO, with timezone) |
| \`{{reservation.arrival_date_local}}\` | Arrival date (local, timezone stripped) |
| \`{{reservation.departure_date}}\` | Departure date (ISO, with timezone) |
| \`{{reservation.departure_date_local}}\` | Departure date (local) |
| \`{{reservation.contract_date}}\` | Contract date |
| \`{{reservation.cancelled_at}}\` | Cancellation timestamp (null if not cancelled) |
| \`{{reservation.last_updated_at}}\` | Last update from PMS |
| \`{{reservation.created_at}}\` | Synced-in timestamp |
| \`{{reservation.modified_at}}\` | Last modified |
| \`{{reservation.custom_fields.FIELD_NAME}}\` | Any custom reservation field |

### units

Array of unit / property records attached to the reservation. Access by index.
Most reservations have one unit; multi-unit bookings have several.

| Token | Meaning |
|---|---|
| \`{{units.0.name}}\` | Unit name |
| \`{{units.0.description}}\` | Short description |
| \`{{units.0.long_description}}\` | Detailed description |
| \`{{units.0.unit_code}}\` | Unit code / number |
| \`{{units.0.unit_type}}\` | Unit type |
| \`{{units.0.pms_id}}\` | PMS-side ID |
| \`{{units.0.external_id}}\` | Connector external ID |
| \`{{units.0.address_1}}\` | Street address |
| \`{{units.0.address_2}}\` | Address line 2 |
| \`{{units.0.locality}}\` | City |
| \`{{units.0.region}}\` | State / region |
| \`{{units.0.postal}}\` | Postal / ZIP |
| \`{{units.0.country}}\` | Country |
| \`{{units.0.locale}}\` | Locale |
| \`{{units.0.occupancy}}\` | Max occupancy |
| \`{{units.0.lat}}\` | Latitude |
| \`{{units.0.lng}}\` | Longitude |
| \`{{units.0.door_code}}\` | Entry door code |
| \`{{units.0.gate_code}}\` | Gate code |
| \`{{units.0.pool_code}}\` | Pool access code |
| \`{{units.0.wifi_ssid}}\` | WiFi SSID |
| \`{{units.0.wifi_code}}\` | WiFi password |
| \`{{units.0.property_code}}\` | Property code |
| \`{{units.0.property_url}}\` | Listing URL |
| \`{{units.0.group_code}}\` | Group code |
| \`{{units.0.condo_building_name}}\` | Condo building name |
| \`{{units.0.condo_unit_number}}\` | Condo unit number |
| \`{{units.0.parcel}}\` | Parcel identifier |
| \`{{units.0.parcel_id}}\` | Parcel ID |
| \`{{units.0.lot_id}}\` | Lot ID |
| \`{{units.0.sq_ft_structure}}\` | Square footage |
| \`{{units.0.year_built}}\` | Year built |
| \`{{units.0.date_last_sold}}\` | Date last sold |
| \`{{units.0.proforma_value_low}}\` | Proforma low estimate |
| \`{{units.0.proforma_value_high}}\` | Proforma high estimate |
| \`{{units.0.taxable_value}}\` | Taxable value |
| \`{{units.0.airbnb_listing_id}}\` | Airbnb listing ID |
| \`{{units.0.created_at}}\` | Unit synced-in timestamp |
| \`{{units.0.modified_at}}\` | Last modified |
| \`{{units.0.assets.0.asset_url}}\` | First photo URL |
| \`{{units.0.assets.0.external_asset_id}}\` | First photo external ID |
| \`{{units.0.assets.0.display_order}}\` | First photo display order |
| \`{{units.0.assets.1.asset_url}}\` | Second photo URL |
| \`{{units.0.assets.2.asset_url}}\` | Third photo URL |
| \`{{units.0.assets.3.asset_url}}\` | Fourth photo URL |
| \`{{units.0.assets.4.asset_url}}\` | Fifth photo URL |
| \`{{units.0.custom_fields.FIELD_NAME}}\` | Any custom unit field |

For second-unit bookings use \`units.1.*\` (same fields, index 1). Photos are
available at \`units.0.assets.0\` through \`.4\` — the editor does not merge past
index 4 by default.

### lead

Sales-lead context — available when the send is attached to a lead (lead
workflow or lead-triggered campaign).

| Token | Meaning |
|---|---|
| \`{{lead.id}}\` | Lead ID |
| \`{{lead.contact_id}}\` | Contact ID |
| \`{{lead.user_id}}\` | Assigned user |
| \`{{lead.subject}}\` | Lead subject |
| \`{{lead.lead_status_id}}\` | Status ID |
| \`{{lead.lead_type_id}}\` | Type ID |
| \`{{lead.source_id}}\` | Source ID |
| \`{{lead.source_related_id}}\` | Source related ID |
| \`{{lead.source_detail_id}}\` | Source detail ID |
| \`{{lead.source_detail_related_id}}\` | Source detail related ID |
| \`{{lead.lost_reason_id}}\` | Lost-reason ID |
| \`{{lead.product_code}}\` | Product code / unit ref |
| \`{{lead.quantity_1}}\` | Quantity 1 (adults) |
| \`{{lead.quantity_2}}\` | Quantity 2 (children) |
| \`{{lead.quantity_3}}\` | Quantity 3 (pets) |
| \`{{lead.estimated_value}}\` | Estimated value |
| \`{{lead.interest_start_at}}\` | Interest window start / arrival |
| \`{{lead.interest_end_at}}\` | Interest window end / departure |
| \`{{lead.followup_at}}\` | Follow-up at |
| \`{{lead.closed_at}}\` | Closed at |
| \`{{lead.won_at}}\` | Won at |
| \`{{lead.reopened_at}}\` | Reopened at |
| \`{{lead.created_at}}\` | Created at |
| \`{{lead.modified_at}}\` | Modified at |
| \`{{lead.custom_fields.FIELD_NAME}}\` | Any custom lead field |

### survey

Survey-assignment context — required for the survey special URL.

| Token | Meaning |
|---|---|
| \`{{survey.id}}\` | Survey assignment ID |
| \`{{survey.name}}\` | Survey name |
| \`{{survey.token}}\` | 10-char token — use in \`https://sndsq.com/s/g/{{survey.token}}\` |

### cart_abandon

Abandoned-cart context — available in cart-abandonment workflows.

| Token | Meaning |
|---|---|
| \`{{cart_abandon.id}}\` | Cart ID |
| \`{{cart_abandon.brand_id}}\` | Brand ID |
| \`{{cart_abandon.campaign_id}}\` | Campaign ID |
| \`{{cart_abandon.pms_id}}\` | PMS property ID |
| \`{{cart_abandon.property_url}}\` | Property URL |
| \`{{cart_abandon.adults}}\` | Adults |
| \`{{cart_abandon.children}}\` | Children |
| \`{{cart_abandon.pets}}\` | Pets |
| \`{{cart_abandon.arrival_date}}\` | Proposed arrival |
| \`{{cart_abandon.departure_date}}\` | Proposed departure |
| \`{{cart_abandon.total_revenue}}\` | Total **(cents)** |
| \`{{cart_abandon.room_revenue}}\` | Room **(cents)** |
| \`{{cart_abandon.extra_revenue}}\` | Extras **(cents)** |
| \`{{cart_abandon.window_closes_at}}\` | Cart expiration |
| \`{{cart_abandon.booked_at}}\` | When the cart was abandoned |

---

## Picking the right tokens for a template

- **Welcome / post-booking confirmation** — contact + reservation + units. Use
  \`units.0.wifi_ssid\`, \`units.0.door_code\`, \`units.0.address_1\`, and the
  guidebook URL for pre-arrival info.
- **Pre-arrival reminders** — reservation + units + guidebook URL. Use
  \`reservation.arrival_date_local\` for human-readable dates.
- **Post-stay review / survey request** — contact + survey (need the
  \`survey.token\`). Link to \`https://sndsq.com/s/g/{{survey.token}}\`.
- **Cart abandon** — cart_abandon + contact. Use \`window_closes_at\` for
  urgency ("your hold expires on …").
- **Re-engagement / marketing campaigns** — contact + company + campaign (for
  the unsubscribe footer).

**Always include** \`{{company.name}}\`, the company address (physical-address
disclosure is a CAN-SPAM requirement), the unsubscribe URL, and the
manage-preferences URL in every marketing email footer.
`
