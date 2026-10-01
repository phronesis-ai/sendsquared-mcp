export enum SurveySendMethod {
  Email = "email",
  Sms = "sms",
  SmsIterative = "sms_iter",
}

export enum SurveyQuestionType {
  YesNo = "yesNo",
  Rating = "rating",
  Multiple = "multiple",
  Radio = "radio",
  Text = "text",
}

export enum SurveyCalculationType {
  ZScore = "zscore",
  Nps = "nps",
}

export enum SurveyAlignment {
  Left = "left",
  Center = "center",
  Right = "right",
}

/*
  The condition vocabulary shared with segments and workflows. Survey end
  links and task configs are evaluated by the same engine, so they take the
  same operators and value types — note that they are spelled out in full
  ("greater", not "gt").
*/
export const SURVEY_CONDITION_OPERATORS = [
  "equal",
  "notEqual",
  "in",
  "notIn",
  "greater",
  "greaterOrEqual",
  "less",
  "lessOrEqual",
  "like",
  "notLike",
  "isNull",
  "isNotNull",
]

export const SURVEY_CONDITION_VALUE_TYPES = [
  "string",
  "integer",
  "number",
  "datetime",
  "datetimeRelative",
  "datetimeMonth",
  "time",
  "date",
  "dateRange",
  "boolean",
  "null",
]

/*
  What a survey condition can test. Response-scoped operands read one
  question's answer and therefore require a question_id; survey-scoped
  operands describe the assignment as a whole.
*/
export const SURVEY_RESPONSE_OPERANDS = [
  "survey_responses.rating",
  "survey_responses.nps_score",
  "survey_responses.answer",
  "survey_responses.yes_no",
  "survey_responses.nps_category",
  "survey_responses.is_promoter",
  "survey_responses.is_detractor",
  "survey_responses.is_passive",
]

export const SURVEY_ASSIGNMENT_OPERANDS = [
  "contact_surveys.response_count",
  "contact_surveys.has_responded",
  "contact_surveys.completed_at",
  "contact_surveys.created_at",
  "contact_surveys.composite_score",
]

export const SURVEY_CONDITION_OPERANDS = [...SURVEY_RESPONSE_OPERANDS, ...SURVEY_ASSIGNMENT_OPERANDS]

export const SURVEY_SEND_METHODS = Object.values(SurveySendMethod)
export const SURVEY_QUESTION_TYPES = Object.values(SurveyQuestionType)
export const SURVEY_CALCULATION_TYPES = Object.values(SurveyCalculationType)
export const SURVEY_ALIGNMENTS = Object.values(SurveyAlignment)

export const SURVEY_LOGO_WIDTH_MIN = 50
export const SURVEY_LOGO_WIDTH_MAX = 350

/*
  Question types whose meaning comes from a fixed list of selectable options.
  Everything else (free text, a rating scale, yes/no) is answered directly by
  the respondent and must not carry an options list.
*/
const CHOICE_QUESTION_TYPES: string[] = [SurveyQuestionType.Multiple, SurveyQuestionType.Radio]

export interface SurveyAnswerInput {
  id?: number
  answer: string
  display_order: number
}

export interface SurveyQuestionInput {
  id?: number
  question: string
  question_type: string
  required: boolean
  display_order: number
  user_id?: number | null
  calculation_type?: string | null
  placeholder_text?: string | null
  rating_label_low?: string | null
  rating_label_high?: string | null
  show_question_number?: boolean
  hide_top_divider?: boolean
  text_rows?: number | null
  answers: SurveyAnswerInput[]
}

export interface SurveyConditionInput {
  condition_type: string
  logic_type: string
  operand: string
  operator: string
  value: string | null
  value_type: string
  question_id?: number | null
}

export interface SurveyEndLinkInput {
  id?: number
  label: string
  url: string
  display_order: number
  conditions: SurveyConditionInput[]
}

export interface SurveyTaskConfigInput {
  id?: number
  task_type_id: number
  label: string
  description?: string | null
  priority?: number | null
  due_offset_seconds: number
  assignee_user_id?: number | null
  queue_id?: number | null
  brand_id?: number | null
  display_order: number
  conditions: SurveyConditionInput[]
}

export interface SurveyPayload {
  name: string
  active: boolean
  send_method: string
  from_id: number
  template_id: number | null
  questions: SurveyQuestionInput[]
  timeout?: number | null
  background_color?: string | null
  primary_text_color?: string | null
  button_color?: string | null
  button_text_color?: string | null
  category_heading_color?: string | null
  category_heading_text_color?: string | null
  category_background_color?: string | null
  brand_id?: number | null
  header_display_logo?: boolean
  header_alignment?: string
  logo_width?: number | null
  logo_alignment?: string
  banner_header_asset_id?: number | null
  banner_footer_asset_id?: number | null
  banner_header_match_frame_width?: boolean
  banner_footer_match_frame_width?: boolean
  show_survey_name?: boolean
  question_number_color?: string | null
  end_links?: SurveyEndLinkInput[]
  task_configs?: SurveyTaskConfigInput[]
}

/*
  The survey fields the write endpoints accept, minus the collections
  (questions / end_links / task_configs) which are normalized separately.
  A GET response also carries id, created_at, modified_at and the derived
  banner_*_url fields; those are server-owned and must not be echoed back.
*/
export const SURVEY_SCALAR_KEYS = [
  "name",
  "active",
  "send_method",
  "from_id",
  "template_id",
  "timeout",
  "background_color",
  "primary_text_color",
  "button_color",
  "button_text_color",
  "category_heading_color",
  "category_heading_text_color",
  "category_background_color",
  "brand_id",
  "header_display_logo",
  "header_alignment",
  "logo_width",
  "logo_alignment",
  "banner_header_asset_id",
  "banner_footer_asset_id",
  "banner_header_match_frame_width",
  "banner_footer_match_frame_width",
  "show_survey_name",
  "question_number_color",
] as const

/*
  The write endpoints validate each field's type strictly, and only these
  survey fields are declared nullable. Every other optional field rejects an
  explicit null — so a field the survey has no value for has to be left out
  of the payload entirely rather than sent as null. This matters because a
  GET returns null for all of them, and those nulls would otherwise be
  echoed straight back into the next update.
*/
const SURVEY_NULLABLE_KEYS = new Set<string>([
  "brand_id",
  "logo_width",
  "banner_header_asset_id",
  "banner_footer_asset_id",
  "question_number_color",
])

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function optId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function optNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function optText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null
  return String(value)
}

export function normalizeSurveyAnswer(raw: unknown, index: number): SurveyAnswerInput {
  const rec = asRecord(raw, `answer ${index + 1}`)
  const answer = rec["answer"]
  if (typeof answer !== "string" || answer.length === 0) {
    throw new Error(`answer ${index + 1} requires a non-empty "answer" string`)
  }
  const out: SurveyAnswerInput = {
    answer,
    display_order: Number(rec["display_order"] ?? index + 1),
  }
  const id = optId(rec["id"])
  if (id !== undefined) out.id = id
  return out
}

/*
  Reduce a question — whether authored by a caller or read back from a GET —
  to exactly the fields the write endpoints accept. Reading a survey returns
  created_at/modified_at alongside the editable fields, and PUT /surveys/{id}
  is a full replace, so every round-trip has to strip the server-owned fields
  and re-send everything else verbatim or the edit silently loses data.
*/
export function normalizeSurveyQuestion(raw: unknown, index: number): SurveyQuestionInput {
  const rec = asRecord(raw, `question ${index + 1}`)
  const question = rec["question"]
  if (typeof question !== "string" || question.length === 0) {
    throw new Error(`question ${index + 1} requires a non-empty "question" string`)
  }
  const questionType = String(rec["question_type"] ?? "")
  if (!SURVEY_QUESTION_TYPES.includes(questionType as SurveyQuestionType)) {
    throw new Error(
      `question ${index + 1} has invalid question_type "${questionType}". Must be one of: ${SURVEY_QUESTION_TYPES.join(", ")}`,
    )
  }

  const rawAnswers = Array.isArray(rec["answers"]) ? (rec["answers"] as unknown[]) : []
  const answers = rawAnswers.map((a, i) => normalizeSurveyAnswer(a, i))
  if (CHOICE_QUESTION_TYPES.includes(questionType) && answers.length === 0) {
    throw new Error(
      `question ${index + 1} is a "${questionType}" question and needs at least one entry in "answers"`,
    )
  }
  if (!CHOICE_QUESTION_TYPES.includes(questionType) && answers.length > 0) {
    throw new Error(
      `question ${index + 1} is a "${questionType}" question and cannot have "answers" — only ${CHOICE_QUESTION_TYPES.join(" and ")} questions take a list of options`,
    )
  }

  const calculationType = optText(rec["calculation_type"])
  if (calculationType !== null && !SURVEY_CALCULATION_TYPES.includes(calculationType as SurveyCalculationType)) {
    throw new Error(
      `question ${index + 1} has invalid calculation_type "${calculationType}". Must be one of: ${SURVEY_CALCULATION_TYPES.join(", ")}`,
    )
  }
  if (calculationType !== null && questionType !== SurveyQuestionType.Rating) {
    throw new Error(
      `question ${index + 1} sets calculation_type but is a "${questionType}" question — scoring only applies to rating questions`,
    )
  }

  const out: SurveyQuestionInput = {
    question,
    question_type: questionType,
    required: rec["required"] === undefined ? false : Boolean(rec["required"]),
    display_order: Number(rec["display_order"] ?? index + 1),
    calculation_type: calculationType,
    placeholder_text: optText(rec["placeholder_text"]),
    rating_label_low: optText(rec["rating_label_low"]),
    rating_label_high: optText(rec["rating_label_high"]),
    show_question_number: rec["show_question_number"] === undefined ? true : Boolean(rec["show_question_number"]),
    hide_top_divider: rec["hide_top_divider"] === undefined ? false : Boolean(rec["hide_top_divider"]),
    text_rows: optNumber(rec["text_rows"]),
    answers,
  }
  const id = optId(rec["id"])
  if (id !== undefined) out.id = id
  /*
    user_id is the only question field that is optional but not nullable, so
    an unassigned question must omit it rather than send null.
  */
  const userId = optId(rec["user_id"])
  if (userId !== undefined) out.user_id = userId
  return out
}

export function normalizeSurveyCondition(raw: unknown, index: number): SurveyConditionInput {
  const rec = asRecord(raw, `condition ${index + 1}`)
  const operand = rec["operand"]
  const operator = rec["operator"]
  if (typeof operand !== "string" || operand.length === 0) {
    throw new Error(`condition ${index + 1} requires an "operand"`)
  }
  if (typeof operator !== "string" || operator.length === 0) {
    throw new Error(`condition ${index + 1} requires an "operator"`)
  }
  if (!SURVEY_CONDITION_OPERATORS.includes(operator)) {
    throw new Error(
      `condition ${index + 1} has invalid operator "${operator}". Must be one of: ${SURVEY_CONDITION_OPERATORS.join(", ")}`,
    )
  }
  const valueType = String(rec["value_type"] ?? "integer")
  if (!SURVEY_CONDITION_VALUE_TYPES.includes(valueType)) {
    throw new Error(
      `condition ${index + 1} has invalid value_type "${valueType}". Must be one of: ${SURVEY_CONDITION_VALUE_TYPES.join(", ")}`,
    )
  }

  const questionId = optId(rec["question_id"])
  /*
    Response-scoped operands read one question's answer, so the API rejects
    them without a question_id. Catching it here names the offending
    condition instead of surfacing a generic validation error.
  */
  if (operand.startsWith("survey_responses.") && questionId === undefined) {
    throw new Error(`condition ${index + 1} on "${operand}" requires a question_id`)
  }
  return {
    condition_type: String(rec["condition_type"] ?? "survey"),
    logic_type: String(rec["logic_type"] ?? "and"),
    operand,
    operator,
    value: rec["value"] === undefined || rec["value"] === null ? null : String(rec["value"]),
    value_type: valueType,
    question_id: questionId ?? null,
  }
}

export function normalizeSurveyEndLink(raw: unknown, index: number): SurveyEndLinkInput {
  const rec = asRecord(raw, `end link ${index + 1}`)
  const label = rec["label"]
  const url = rec["url"]
  if (typeof label !== "string" || label.length === 0) {
    throw new Error(`end link ${index + 1} requires a "label"`)
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(`end link ${index + 1} requires a "url"`)
  }
  const rawConditions = Array.isArray(rec["conditions"]) ? (rec["conditions"] as unknown[]) : []
  const out: SurveyEndLinkInput = {
    label,
    url,
    display_order: Number(rec["display_order"] ?? index),
    conditions: rawConditions.map((c, i) => normalizeSurveyCondition(c, i)),
  }
  const id = optId(rec["id"])
  if (id !== undefined) out.id = id
  return out
}

export function normalizeSurveyTaskConfig(raw: unknown, index: number): SurveyTaskConfigInput {
  const rec = asRecord(raw, `task config ${index + 1}`)
  const label = rec["label"]
  if (typeof label !== "string" || label.length === 0) {
    throw new Error(`task config ${index + 1} requires a "label"`)
  }
  const taskTypeId = optId(rec["task_type_id"])
  if (taskTypeId === undefined) {
    throw new Error(`task config ${index + 1} requires a numeric "task_type_id"`)
  }
  const rawConditions = Array.isArray(rec["conditions"]) ? (rec["conditions"] as unknown[]) : []
  const out: SurveyTaskConfigInput = {
    task_type_id: taskTypeId,
    label,
    description: optText(rec["description"]),
    priority: optNumber(rec["priority"]),
    due_offset_seconds: Number(rec["due_offset_seconds"] ?? 86400),
    assignee_user_id: optNumber(rec["assignee_user_id"]),
    queue_id: optNumber(rec["queue_id"]),
    brand_id: optNumber(rec["brand_id"]),
    display_order: Number(rec["display_order"] ?? index),
    conditions: rawConditions.map((c, i) => normalizeSurveyCondition(c, i)),
  }
  const id = optId(rec["id"])
  if (id !== undefined) out.id = id
  return out
}

/*
  Renumber questions 1..n in array order. Display order is what the
  respondent sees, and add/remove/reorder operations all leave gaps or
  duplicates behind unless the whole list is resequenced afterwards.
*/
export function renumberQuestions(questions: SurveyQuestionInput[]): SurveyQuestionInput[] {
  return questions.map((q, i) => ({
    ...q,
    display_order: i + 1,
    answers: q.answers.map((a, j) => ({ ...a, display_order: j + 1 })),
  }))
}

/*
  Turn a survey read back from GET /surveys/{id} into a body that can be sent
  straight to PUT /surveys/{id}. The update endpoint is a full idempotent
  replace: any question, answer, end link or task config absent from the body
  is deleted, and several presentation fields fall back to their defaults when
  omitted. So every edit is a read-modify-write over this complete payload —
  never a partial patch.
*/
export function surveyToPayload(record: Record<string, unknown>): SurveyPayload {
  const rawQuestions = Array.isArray(record["questions"]) ? (record["questions"] as unknown[]) : []
  const payload: Record<string, unknown> = {
    questions: rawQuestions.map((q, i) => normalizeSurveyQuestion(q, i)),
  }
  for (const key of SURVEY_SCALAR_KEYS) {
    if (!(key in record)) continue
    const value = record[key]
    if ((value === null || value === undefined) && !SURVEY_NULLABLE_KEYS.has(key)) continue
    payload[key] = value
  }
  if (Array.isArray(record["end_links"])) {
    payload["end_links"] = (record["end_links"] as unknown[]).map((l, i) => normalizeSurveyEndLink(l, i))
  }
  if (Array.isArray(record["task_configs"])) {
    payload["task_configs"] = (record["task_configs"] as unknown[]).map((c, i) => normalizeSurveyTaskConfig(c, i))
  }
  return payload as unknown as SurveyPayload
}

/*
  template_id is required by the write endpoints but nullable in the database,
  so a survey that predates having a delivery template reads back with no
  usable value and cannot be written until one is supplied. Catching it here
  explains what to do instead of surfacing a bare "required" validation error.
*/
export function assertSurveyPayload(payload: SurveyPayload): SurveyPayload {
  if (payload.template_id === undefined || payload.template_id === null) {
    throw new Error(
      "template_id is required to save a survey, and this survey has none set. Pass a template_id — list the available email templates to pick one.",
    )
  }
  return payload
}

/*
  Overlay caller-supplied changes onto a carried-forward payload. Only keys
  the caller actually set are applied, so an update touching one field leaves
  the rest of the survey — including its questions — exactly as it was.
*/
export function mergeSurveyPayload(
  current: SurveyPayload,
  overlay: Partial<SurveyPayload>,
): SurveyPayload {
  const merged: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as unknown as SurveyPayload
}
