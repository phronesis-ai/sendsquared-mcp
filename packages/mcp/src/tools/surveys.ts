import {
  SURVEY_ALIGNMENTS,
  SURVEY_CALCULATION_TYPES,
  assertSurveyPayload,
  SURVEY_LOGO_WIDTH_MAX,
  SURVEY_LOGO_WIDTH_MIN,
  SURVEY_CONDITION_OPERANDS,
  SURVEY_CONDITION_OPERATORS,
  SURVEY_CONDITION_VALUE_TYPES,
  SURVEY_QUESTION_TYPES,
  SURVEY_SEND_METHODS,
  mergeSurveyPayload,
  normalizeSurveyEndLink,
  normalizeSurveyQuestion,
  normalizeSurveyTaskConfig,
  renumberQuestions,
  surveyToPayload,
  reportRunBody,
  workflowSurveySteps,
  sumSurveyActivity,
  countByStatus,
  type SurveyEndLinkInput,
  type SurveyPayload,
  type SurveyQuestionInput,
  type SurveyTaskConfigInput,
} from "@sendsquared/client"
import { apiForRequest, requestCompanyId, envelope, asString, asOptString, asNumber, asOptNumber, asOptBoolean } from "./shared.js"
import type { ToolDefinition } from "./types.js"

const SURVEY_PATH = "/surveys"

function surveyPath(id: string): string {
  return `${SURVEY_PATH}/${encodeURIComponent(id)}`
}

/*
  Every write to a survey is a read-modify-write. PUT /surveys/{id} is a full
  idempotent replace — questions, answers, end links and task configs missing
  from the body are deleted, and the presentation fields fall back to their
  defaults when omitted — so the current survey is always fetched, converted
  to a complete payload, and only then overlaid with the caller's changes.
*/
async function loadPayload(id: string): Promise<SurveyPayload> {
  const current = (await apiForRequest().get(surveyPath(id))) as Record<string, unknown>
  return surveyToPayload(current)
}

async function putPayload(id: string, payload: SurveyPayload): Promise<unknown> {
  return apiForRequest().put(surveyPath(id), assertSurveyPayload(payload))
}

const QUESTION_SCHEMA = {
  type: "object",
  required: ["question", "question_type"],
  properties: {
    id: { type: "number", description: "Existing question id — omit to create a new question" },
    question: { type: "string", description: "The question text shown to the respondent" },
    question_type: {
      type: "string",
      enum: SURVEY_QUESTION_TYPES,
      description:
        "yesNo (yes/no), rating (numeric scale), radio (pick one option), multiple (pick many options), text (free-form)",
    },
    required: { type: "boolean", description: "Whether an answer is mandatory", default: false },
    display_order: { type: "number", description: "1-based position; defaults to array order" },
    calculation_type: {
      type: "string",
      enum: SURVEY_CALCULATION_TYPES,
      description: "Rating questions only: zscore for relative scoring, nps for Net Promoter Score (0-10 scale)",
    },
    user_id: { type: "number", description: "User notified about answers to this question" },
    placeholder_text: { type: "string", description: "Text questions only: placeholder shown in the input" },
    text_rows: { type: "number", description: "Text questions only: height of the input in rows" },
    rating_label_low: { type: "string", description: "Rating questions only: label for the low end of the scale" },
    rating_label_high: { type: "string", description: "Rating questions only: label for the high end of the scale" },
    show_question_number: { type: "boolean", description: "Show the question number", default: true },
    hide_top_divider: { type: "boolean", description: "Hide the divider above the question", default: false },
    answers: {
      type: "array",
      description: "Selectable options — required for radio and multiple, and rejected for every other type",
      items: {
        type: "object",
        required: ["answer"],
        properties: {
          id: { type: "number", description: "Existing option id — omit to create a new option" },
          answer: { type: "string", description: "Option text" },
          display_order: { type: "number", description: "1-based position; defaults to array order" },
        },
      },
    },
  },
} as const

/*
  The question fields minus `id`. The single-question tools address the
  question through their own parameter (question_id) and reserve `id` for the
  survey, so folding the whole question schema in unchanged would redefine
  `id` as the question's.
*/
const { id: _questionIdProperty, ...QUESTION_FIELDS } = QUESTION_SCHEMA.properties

function pickQuestionFields(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(QUESTION_FIELDS)) {
    if (args[key] !== undefined) out[key] = args[key]
  }
  return out
}

const CONDITION_SCHEMA = {
  type: "object",
  required: ["operand", "operator"],
  properties: {
    condition_type: { type: "string", description: "Condition family", default: "survey" },
    logic_type: { type: "string", enum: ["and", "or"], description: "How this condition combines with the others", default: "and" },
    operand: {
      type: "string",
      enum: SURVEY_CONDITION_OPERANDS,
      description:
        "What is being tested. The survey_responses.* operands read one question's answer and require question_id; " +
        "the contact_surveys.* operands describe the assignment as a whole.",
    },
    operator: {
      type: "string",
      enum: SURVEY_CONDITION_OPERATORS,
      description: "Comparison operator — spelled out in full ('greater', not 'gt')",
    },
    value: { type: "string", description: "Value to compare against" },
    value_type: {
      type: "string",
      enum: SURVEY_CONDITION_VALUE_TYPES,
      description: "Type of the value",
      default: "integer",
    },
    question_id: { type: "number", description: "Question the response-scoped operand reads — required for survey_responses.* operands" },
  },
} as const

const END_LINK_SCHEMA = {
  type: "object",
  required: ["label", "url"],
  properties: {
    id: { type: "number", description: "Existing end link id — omit to create a new one" },
    label: { type: "string", description: "Button text" },
    url: { type: "string", description: "Destination URL" },
    display_order: { type: "number", description: "0-based position; defaults to array order" },
    conditions: { type: "array", items: CONDITION_SCHEMA, description: "Show the link only when these conditions match; empty means always show" },
  },
} as const

const TASK_CONFIG_SCHEMA = {
  type: "object",
  required: ["task_type_id", "label", "due_offset_seconds"],
  properties: {
    id: { type: "number", description: "Existing task config id — omit to create a new one" },
    task_type_id: { type: "number", description: "Task type to create (call sendsquared_task_types_list)" },
    label: { type: "string", description: "Task title" },
    description: { type: "string", description: "Task description" },
    priority: { type: "number", description: "Task priority" },
    due_offset_seconds: { type: "number", description: "Seconds after the response before the task is due (86400 = 1 day)" },
    assignee_user_id: { type: "number", description: "User the task is assigned to" },
    queue_id: { type: "number", description: "Queue the task lands in" },
    brand_id: { type: "number", description: "Brand the task belongs to" },
    display_order: { type: "number", description: "0-based position; defaults to array order" },
    conditions: { type: "array", items: CONDITION_SCHEMA, description: "Create the task only when these conditions match; empty means always create" },
  },
} as const

/*
  Presentation and delivery fields shared by create and update. They are
  spelled the same on both endpoints, so the schema and the collector below
  serve both — create builds a full payload, update overlays a partial one.
*/
const SURVEY_SETTINGS_SCHEMA = {
  active: { type: "boolean", description: "Whether the survey can be sent and answered" },
  send_method: { type: "string", enum: SURVEY_SEND_METHODS, description: "email, sms (one link), or sms_iter (questions asked one at a time over SMS)" },
  from_id: { type: "number", description: "Sender id: a verified email id for send_method=email, or a phone number id for sms/sms_iter" },
  template_id: { type: "number", description: "Email template used to deliver the survey" },
  timeout: { type: "number", description: "Seconds before an unanswered survey expires" },
  brand_id: { type: "number", description: "Brand whose logo and identity the survey uses" },
  background_color: { type: "string", description: "Page background, 6-digit hex (e.g. #FFFFFF)" },
  primary_text_color: { type: "string", description: "Body text color, 6-digit hex" },
  button_color: { type: "string", description: "Button fill color, 6-digit hex" },
  button_text_color: { type: "string", description: "Button label color, 6-digit hex" },
  category_heading_color: { type: "string", description: "Category heading color, 6-digit hex" },
  category_heading_text_color: { type: "string", description: "Category heading text color, 6-digit hex" },
  category_background_color: { type: "string", description: "Category background color, 6-digit hex" },
  question_number_color: { type: "string", description: "Question number color, 6-digit hex" },
  header_display_logo: { type: "boolean", description: "Show the brand logo in the header" },
  header_alignment: { type: "string", enum: SURVEY_ALIGNMENTS, description: "Header alignment" },
  logo_alignment: { type: "string", enum: SURVEY_ALIGNMENTS, description: "Logo alignment" },
  logo_width: { type: "number", description: `Logo width in pixels (${SURVEY_LOGO_WIDTH_MIN}-${SURVEY_LOGO_WIDTH_MAX})` },
  banner_header_asset_id: { type: "number", description: "Asset id for the header banner image" },
  banner_footer_asset_id: { type: "number", description: "Asset id for the footer banner image" },
  banner_header_match_frame_width: { type: "boolean", description: "Stretch the header banner to the frame width" },
  banner_footer_match_frame_width: { type: "boolean", description: "Stretch the footer banner to the frame width" },
  show_survey_name: { type: "boolean", description: "Show the survey name at the top of the page" },
} as const

const BOOLEAN_SETTINGS = [
  "active",
  "header_display_logo",
  "banner_header_match_frame_width",
  "banner_footer_match_frame_width",
  "show_survey_name",
]

const NUMBER_SETTINGS = [
  "from_id",
  "template_id",
  "timeout",
  "brand_id",
  "logo_width",
  "banner_header_asset_id",
  "banner_footer_asset_id",
]

const STRING_SETTINGS = [
  "send_method",
  "header_alignment",
  "logo_alignment",
  "background_color",
  "primary_text_color",
  "button_color",
  "button_text_color",
  "category_heading_color",
  "category_heading_text_color",
  "category_background_color",
  "question_number_color",
]

function collectSettings(args: Record<string, unknown>): Partial<SurveyPayload> {
  const out: Record<string, unknown> = {}
  for (const key of BOOLEAN_SETTINGS) {
    const v = asOptBoolean(args[key])
    if (v !== undefined) out[key] = v
  }
  for (const key of NUMBER_SETTINGS) {
    const v = asOptNumber(args[key])
    if (v !== undefined) out[key] = v
  }
  for (const key of STRING_SETTINGS) {
    const v = asOptString(args[key])
    if (v !== undefined) out[key] = v
  }
  return out as Partial<SurveyPayload>
}

function questionsFromArgs(args: Record<string, unknown>, key = "questions"): SurveyQuestionInput[] | undefined {
  if (!Array.isArray(args[key])) return undefined
  return (args[key] as unknown[]).map((q, i) => normalizeSurveyQuestion(q, i))
}

function endLinksFromArgs(args: Record<string, unknown>): SurveyEndLinkInput[] | undefined {
  if (!Array.isArray(args["end_links"])) return undefined
  return (args["end_links"] as unknown[]).map((l, i) => normalizeSurveyEndLink(l, i))
}

function taskConfigsFromArgs(args: Record<string, unknown>): SurveyTaskConfigInput[] | undefined {
  if (!Array.isArray(args["task_configs"])) return undefined
  return (args["task_configs"] as unknown[]).map((c, i) => normalizeSurveyTaskConfig(c, i))
}

function questionSummary(payload: SurveyPayload): string {
  const n = payload.questions.length
  return `${n} question${n === 1 ? "" : "s"}`
}

export const surveysList: ToolDefinition = {
  name: "sendsquared_surveys_list",
  description:
    "List SendSquared surveys. Returns each survey's name, active flag, send method and styling. " +
    "Pass stats=true to include response counts. Note that an empty list can also mean the survey " +
    "feature is not enabled for this account.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Results per page", default: 100 },
      after_id: { type: "number", description: "Pagination cursor: return surveys with id above this", default: 0 },
      stats: { type: "boolean", description: "Include total / completed / errored response counts", default: false },
      filter: {
        type: "array",
        items: { type: "string" },
        description: "Colon-delimited filters, e.g. ['active:eq:true']",
      },
      sort: { type: "array", items: { type: "string" }, description: "Sort directives, e.g. ['name:asc']" },
    },
  },
  handler: async (args) => {
    const query: Record<string, string | number | string[] | undefined> = {
      limit: asOptNumber(args["limit"]) ?? 100,
      after_id: asOptNumber(args["after_id"]) ?? 0,
    }
    if (asOptBoolean(args["stats"])) query["stats"] = "true"
    if (Array.isArray(args["filter"])) query["filter"] = args["filter"] as string[]
    if (Array.isArray(args["sort"])) query["sort"] = args["sort"] as string[]

    const result = await apiForRequest().list(SURVEY_PATH, query)
    return envelope(
      { surveys: result.data, total: result.total },
      `${result.total} surveys`,
      ["sendsquared_surveys_get", "sendsquared_surveys_create"],
    )
  },
}

export const surveysGet: ToolDefinition = {
  name: "sendsquared_surveys_get",
  description:
    "Fetch a single SendSquared survey by id with its full question list (including each question's " +
    "selectable options), end links and task configs. Read this before editing — every survey write " +
    "replaces the whole document.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Survey id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = (await apiForRequest().get(surveyPath(id))) as Record<string, unknown>
    const questions = Array.isArray(data["questions"]) ? data["questions"].length : 0
    return envelope(data, `Survey ${id}: ${data["name"]} (${questions} questions)`, [
      "sendsquared_surveys_update",
      "sendsquared_surveys_questions_add",
      "sendsquared_surveys_report",
    ])
  },
}

export const surveysCreate: ToolDefinition = {
  name: "sendsquared_surveys_create",
  description:
    "Create a new SendSquared survey with its questions. Requires a name, a send_method, a from_id " +
    "(a verified email id for send_method=email, or a phone number id for sms), a template_id (from " +
    "sendsquared_email_templates_list) and at least one question. New surveys default to inactive " +
    "unless you pass active=true.",
  inputSchema: {
    type: "object",
    required: ["name", "send_method", "from_id", "template_id", "questions"],
    properties: {
      name: { type: "string", description: "Survey name" },
      questions: { type: "array", items: QUESTION_SCHEMA, description: "Questions in the order respondents see them" },
      end_links: { type: "array", items: END_LINK_SCHEMA, description: "Buttons shown on the thank-you page after submitting" },
      task_configs: { type: "array", items: TASK_CONFIG_SCHEMA, description: "Tasks created automatically from responses" },
      ...SURVEY_SETTINGS_SCHEMA,
    },
  },
  handler: async (args) => {
    const name = asString(args["name"], "name")
    const questions = questionsFromArgs(args)
    if (!questions || questions.length === 0) {
      throw new Error("questions is required and must contain at least one question")
    }
    const sendMethod = asString(args["send_method"], "send_method")
    if (!SURVEY_SEND_METHODS.includes(sendMethod as never)) {
      throw new Error(`send_method must be one of: ${SURVEY_SEND_METHODS.join(", ")}`)
    }
    /*
      header_display_logo has to be sent explicitly. Its column is NOT NULL
      with no default and the create endpoint passes the value straight
      through, so omitting it fails the insert with a bare 500 rather than a
      validation error. The other presentation fields are defaulted server-side.
    */
    const payload: Record<string, unknown> = {
      name,
      active: false,
      header_display_logo: false,
      ...collectSettings(args),
      send_method: sendMethod,
      from_id: asNumber(args["from_id"], "from_id"),
      template_id: asNumber(args["template_id"], "template_id"),
      questions: renumberQuestions(questions),
    }
    const endLinks = endLinksFromArgs(args)
    if (endLinks) payload["end_links"] = endLinks
    const taskConfigs = taskConfigsFromArgs(args)
    if (taskConfigs) payload["task_configs"] = taskConfigs

    const data = (await apiForRequest().post(SURVEY_PATH, payload)) as Record<string, unknown>
    return envelope(data, `Survey created: ${name} (${questions.length} questions)`, [
      "sendsquared_surveys_get",
      "sendsquared_surveys_assign",
    ])
  },
}

export const surveysUpdate: ToolDefinition = {
  name: "sendsquared_surveys_update",
  description:
    "Update a SendSquared survey. Only the fields you pass are changed — the current survey is read " +
    "first and everything else is carried forward, including its questions. Passing 'questions' " +
    "replaces the entire question list: questions you omit are deleted, and questions you include " +
    "without an id are created, so include each existing question's id (and each option's id) to " +
    "keep it. sendsquared_surveys_questions_update edits one question without resending the rest.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      name: { type: "string", description: "Survey name" },
      questions: { type: "array", items: QUESTION_SCHEMA, description: "Full replacement question list — omitted questions are deleted" },
      end_links: { type: "array", items: END_LINK_SCHEMA, description: "Full replacement end link list — omitted links are deleted" },
      task_configs: { type: "array", items: TASK_CONFIG_SCHEMA, description: "Full replacement task config list — omitted configs are deleted" },
      ...SURVEY_SETTINGS_SCHEMA,
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const current = await loadPayload(id)
    const overlay: Partial<SurveyPayload> = collectSettings(args)
    const name = asOptString(args["name"])
    if (name !== undefined) overlay.name = name
    const questions = questionsFromArgs(args)
    if (questions) overlay.questions = renumberQuestions(questions)
    const endLinks = endLinksFromArgs(args)
    if (endLinks) overlay.end_links = endLinks
    const taskConfigs = taskConfigsFromArgs(args)
    if (taskConfigs) overlay.task_configs = taskConfigs

    const payload = mergeSurveyPayload(current, overlay)
    const data = await putPayload(id, payload)
    return envelope(data, `Survey ${id} updated (${questionSummary(payload)})`, [
      "sendsquared_surveys_get",
    ])
  },
}

export const surveysQuestionsAdd: ToolDefinition = {
  name: "sendsquared_surveys_questions_add",
  description:
    "Add one question to an existing SendSquared survey, leaving every other question untouched. " +
    "Appended to the end by default; pass position to insert it earlier.",
  inputSchema: {
    type: "object",
    required: ["id", "question", "question_type"],
    properties: {
      id: { type: "string", description: "Survey id" },
      position: { type: "number", description: "1-based position to insert at; defaults to the end" },
      ...QUESTION_FIELDS,
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const current = await loadPayload(id)
    const question = normalizeSurveyQuestion(pickQuestionFields(args), current.questions.length)
    const position = asOptNumber(args["position"])
    const questions = [...current.questions]
    const index = position === undefined ? questions.length : Math.max(0, Math.min(questions.length, position - 1))
    questions.splice(index, 0, question)

    const payload = mergeSurveyPayload(current, { questions: renumberQuestions(questions) })
    const data = await putPayload(id, payload)
    return envelope(data, `Question added to survey ${id} at position ${index + 1} (${questionSummary(payload)})`, [
      "sendsquared_surveys_get",
      "sendsquared_surveys_questions_update",
    ])
  },
}

export const surveysQuestionsUpdate: ToolDefinition = {
  name: "sendsquared_surveys_questions_update",
  description:
    "Edit one question on a SendSquared survey in place. Only the fields you pass are changed and " +
    "every other question is preserved. Passing 'answers' replaces that question's option list, so " +
    "include each option's id to keep it. Note that the API cannot clear an existing " +
    "calculation_type or placeholder_text — it ignores empty values for those two fields.",
  inputSchema: {
    type: "object",
    required: ["id", "question_id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      question_id: { type: "number", description: "Id of the question to edit" },
      ...QUESTION_FIELDS,
      question: { type: "string", description: "New question text" },
      question_type: { type: "string", enum: SURVEY_QUESTION_TYPES, description: "New question type" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const questionId = asNumber(args["question_id"], "question_id")
    const current = await loadPayload(id)
    const index = current.questions.findIndex((q) => q.id === questionId)
    if (index === -1) {
      throw new Error(`Survey ${id} has no question with id ${questionId}`)
    }

    /*
      Overlay the supplied fields onto the existing question before
      re-normalizing, so the type/answers consistency checks run against the
      merged result rather than against a partial input.
    */
    const existing = current.questions[index]!
    const patch: Record<string, unknown> = {
      ...existing,
      ...pickQuestionFields(args),
      id: questionId,
    }

    const questions = [...current.questions]
    questions[index] = normalizeSurveyQuestion(patch, index)

    const payload = mergeSurveyPayload(current, { questions: renumberQuestions(questions) })
    const data = await putPayload(id, payload)
    return envelope(data, `Question ${questionId} updated on survey ${id}`, ["sendsquared_surveys_get"])
  },
}

export const surveysQuestionsRemove: ToolDefinition = {
  name: "sendsquared_surveys_questions_remove",
  description:
    "Remove one question from a SendSquared survey. This is a soft delete: the question is retired, " +
    "its recorded answers stay in historical reports, and the remaining questions are renumbered. " +
    "Guests stop seeing the question.",
  inputSchema: {
    type: "object",
    required: ["id", "question_id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      question_id: { type: "number", description: "Id of the question to remove" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const questionId = asNumber(args["question_id"], "question_id")
    const current = await loadPayload(id)
    const questions = current.questions.filter((q) => q.id !== questionId)
    if (questions.length === current.questions.length) {
      throw new Error(`Survey ${id} has no question with id ${questionId}`)
    }

    const payload = mergeSurveyPayload(current, { questions: renumberQuestions(questions) })
    const data = await putPayload(id, payload)
    return envelope(data, `Question ${questionId} removed from survey ${id} (${questionSummary(payload)})`, [
      "sendsquared_surveys_get",
    ])
  },
}

export const surveysQuestionsReorder: ToolDefinition = {
  name: "sendsquared_surveys_questions_reorder",
  description:
    "Reorder a SendSquared survey's questions. Pass every question id in the order respondents " +
    "should see them; the questions themselves are unchanged.",
  inputSchema: {
    type: "object",
    required: ["id", "question_ids"],
    properties: {
      id: { type: "string", description: "Survey id" },
      question_ids: {
        type: "array",
        items: { type: "number" },
        description: "Every question id on the survey, in the desired order",
      },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    if (!Array.isArray(args["question_ids"])) {
      throw new Error("question_ids is required and must be an array of question ids")
    }
    const order = (args["question_ids"] as unknown[]).map((v) => Number(v))
    const current = await loadPayload(id)
    const byId = new Map(current.questions.map((q) => [q.id, q]))
    /*
      Require the full set. A partial order would silently drop the questions
      left out of it, because the update endpoint deletes anything absent
      from the payload.
    */
    if (order.length !== current.questions.length) {
      throw new Error(
        `question_ids must list all ${current.questions.length} questions on survey ${id}; got ${order.length}`,
      )
    }
    const reordered: SurveyQuestionInput[] = []
    for (const qid of order) {
      const q = byId.get(qid)
      if (!q) throw new Error(`Survey ${id} has no question with id ${qid}`)
      if (reordered.includes(q)) throw new Error(`Question id ${qid} listed more than once`)
      reordered.push(q)
    }

    const payload = mergeSurveyPayload(current, { questions: renumberQuestions(reordered) })
    const data = await putPayload(id, payload)
    return envelope(data, `Survey ${id} questions reordered`, ["sendsquared_surveys_get"])
  },
}

export const surveysEndLinksSet: ToolDefinition = {
  name: "sendsquared_surveys_end_links_set",
  description:
    "Replace the buttons shown on a survey's thank-you page. Pass the complete list — end links you " +
    "omit are deleted, and links without an id are created. Each link can carry conditions so it only " +
    "appears for certain responses (e.g. a review link for promoters).",
  inputSchema: {
    type: "object",
    required: ["id", "end_links"],
    properties: {
      id: { type: "string", description: "Survey id" },
      end_links: { type: "array", items: END_LINK_SCHEMA, description: "Complete end link list; pass [] to remove them all" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const endLinks = endLinksFromArgs(args)
    if (!endLinks) throw new Error("end_links is required and must be an array")
    const current = await loadPayload(id)
    const payload = mergeSurveyPayload(current, { end_links: endLinks })
    const data = await putPayload(id, payload)
    return envelope(data, `Survey ${id} end links set (${endLinks.length})`, ["sendsquared_surveys_get"])
  },
}

export const surveysTaskConfigsSet: ToolDefinition = {
  name: "sendsquared_surveys_task_configs_set",
  description:
    "Replace the automatic task rules on a survey. Each config creates a task when a response matches " +
    "its conditions — e.g. a call-back task when a rating question scores below 8. Pass the complete " +
    "list: configs you omit are deleted, and configs without an id are created.",
  inputSchema: {
    type: "object",
    required: ["id", "task_configs"],
    properties: {
      id: { type: "string", description: "Survey id" },
      task_configs: { type: "array", items: TASK_CONFIG_SCHEMA, description: "Complete task config list; pass [] to remove them all" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const taskConfigs = taskConfigsFromArgs(args)
    if (!taskConfigs) throw new Error("task_configs is required and must be an array")
    const current = await loadPayload(id)
    const payload = mergeSurveyPayload(current, { task_configs: taskConfigs })
    const data = await putPayload(id, payload)
    return envelope(data, `Survey ${id} task configs set (${taskConfigs.length})`, ["sendsquared_surveys_get"])
  },
}

export const surveysDuplicate: ToolDefinition = {
  name: "sendsquared_surveys_duplicate",
  description:
    "Duplicate a SendSquared survey, including its questions, end links and task configs. The copy is " +
    "named '<name> (Copy)' and starts inactive — a safe way to revise a survey that already has responses.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Survey id to copy" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = (await apiForRequest().post(`${surveyPath(id)}/duplicate`)) as Record<string, unknown>
    return envelope(data, `Survey ${id} duplicated as ${data["id"]}`, [
      "sendsquared_surveys_get",
      "sendsquared_surveys_update",
    ])
  },
}

export const surveysAssign: ToolDefinition = {
  name: "sendsquared_surveys_assign",
  description:
    "Assign a survey to a contact, minting the response token used in the survey link. Use this to " +
    "send a survey to one person outside a workflow. The survey is delivered to the contact.",
  inputSchema: {
    type: "object",
    required: ["id", "contact_id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      contact_id: { type: "number", description: "Contact to assign the survey to" },
      related_type: { type: "string", description: "Record type this assignment relates to, e.g. reservation" },
      related_id: { type: "number", description: "Id of the related record" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const body: Record<string, unknown> = { contact_id: asNumber(args["contact_id"], "contact_id") }
    const relatedType = asOptString(args["related_type"])
    if (relatedType !== undefined) body["related_type"] = relatedType
    const relatedId = asOptNumber(args["related_id"])
    if (relatedId !== undefined) body["related_id"] = relatedId

    const data = (await apiForRequest().post(`${surveyPath(id)}/assign`, body)) as Record<string, unknown>
    return envelope(data, `Survey ${id} assigned to contact ${body["contact_id"]}`, [
      "sendsquared_contact_surveys_list",
    ])
  },
}

export const surveysReport: ToolDefinition = {
  name: "sendsquared_surveys_report",
  description:
    "Response rollup for one survey: answer counts per question, respondent totals, z-scores for " +
    "rating questions and NPS scores where configured.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      start_date: { type: "string", description: "Start of the window, YYYY-MM-DD" },
      end_date: { type: "string", description: "End of the window, YYYY-MM-DD" },
      reservation_type: { type: "string", description: "Restrict to responses tied to this reservation type" },
      status: { type: "string", description: "Restrict to assignments in this status, e.g. completed" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const query: Record<string, string | undefined> = {
      start_date: asOptString(args["start_date"]),
      end_date: asOptString(args["end_date"]),
      reservation_type: asOptString(args["reservation_type"]),
      status: asOptString(args["status"]),
    }
    const data = (await apiForRequest().get(`${surveyPath(id)}/report/`, query)) as Record<string, unknown>
    return envelope(data, `Survey ${id} report — ${data["respondants"] ?? 0} respondents`, [
      "sendsquared_surveys_nps_score",
      "sendsquared_surveys_get",
    ])
  },
}

export const surveysNpsScore: ToolDefinition = {
  name: "sendsquared_surveys_nps_score",
  description:
    "Net Promoter Score for a survey, with the promoter / passive / detractor breakdown. Requires a " +
    "rating question configured with calculation_type=nps.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      start_date: { type: "string", description: "Start of the window, YYYY-MM-DD" },
      end_date: { type: "string", description: "End of the window, YYYY-MM-DD" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = (await apiForRequest().get(`${surveyPath(id)}/nps-score`, {
      start_date: asOptString(args["start_date"]),
      end_date: asOptString(args["end_date"]),
    })) as Record<string, unknown>
    return envelope(data, `Survey ${id} NPS: ${data["npsScore"]}`, ["sendsquared_surveys_report"])
  },
}

export const surveysTaskReport: ToolDefinition = {
  name: "sendsquared_surveys_task_report",
  description:
    "Task timeline for a survey: every response that generated a task, with stay dates, assignee, " +
    "due date and completion. Use it to see how follow-up on survey feedback is being handled.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: {
      id: { type: "string", description: "Survey id" },
      start_date: { type: "string", description: "Start of the window, YYYY-MM-DD" },
      end_date: { type: "string", description: "End of the window, YYYY-MM-DD" },
      completed: { type: "string", description: "Filter by task completion state" },
      limit: { type: "number", description: "Maximum rows to return" },
      offset: { type: "number", description: "Rows to skip" },
    },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = (await apiForRequest().get(`${surveyPath(id)}/task-report/`, {
      start_date: asOptString(args["start_date"]),
      end_date: asOptString(args["end_date"]),
      completed: asOptString(args["completed"]),
      limit: asOptNumber(args["limit"]),
      offset: asOptNumber(args["offset"]),
    })) as Record<string, unknown>
    return envelope(data, `Survey ${id} task report — ${data["total"] ?? 0} rows`, ["sendsquared_surveys_report"])
  },
}

export const surveysRollupReport: ToolDefinition = {
  name: "sendsquared_surveys_rollup_report",
  description:
    "Per-respondent rollup across one or more surveys for a date window. The window cannot exceed " +
    "30 days.",
  inputSchema: {
    type: "object",
    required: ["survey_ids", "start_date", "end_date"],
    properties: {
      survey_ids: { type: "array", items: { type: "number" }, description: "Survey ids to include" },
      start_date: { type: "string", description: "Start of the window, YYYY-MM-DD" },
      end_date: { type: "string", description: "End of the window, YYYY-MM-DD (max 30 days after start_date)" },
      status: { type: "string", description: "Restrict to assignments in this status" },
      task_assignee_user_id: { type: "number", description: "Restrict to responses whose task is assigned to this user" },
    },
  },
  handler: async (args) => {
    if (!Array.isArray(args["survey_ids"]) || args["survey_ids"].length === 0) {
      throw new Error("survey_ids is required and must contain at least one survey id")
    }
    const data = (await apiForRequest().get(`${SURVEY_PATH}/rollup-report/`, {
      survey_ids: (args["survey_ids"] as unknown[]).map((v) => Number(v)),
      start_date: asString(args["start_date"], "start_date"),
      end_date: asString(args["end_date"], "end_date"),
      status: asOptString(args["status"]),
      task_assignee_user_id: asOptNumber(args["task_assignee_user_id"]),
    })) as Record<string, unknown>
    return envelope(data, `Survey rollup report for ${(args["survey_ids"] as unknown[]).length} surveys`, [
      "sendsquared_surveys_rating_trends",
    ])
  },
}

export const surveysRatingTrends: ToolDefinition = {
  name: "sendsquared_surveys_rating_trends",
  description:
    "Day-by-day rating trends across one or more surveys. The window cannot exceed 31 days.",
  inputSchema: {
    type: "object",
    required: ["survey_ids", "start_date", "end_date"],
    properties: {
      survey_ids: { type: "array", items: { type: "number" }, description: "Survey ids to include" },
      start_date: { type: "string", description: "Start of the window, YYYY-MM-DD" },
      end_date: { type: "string", description: "End of the window, YYYY-MM-DD (max 31 days inclusive)" },
    },
  },
  handler: async (args) => {
    if (!Array.isArray(args["survey_ids"]) || args["survey_ids"].length === 0) {
      throw new Error("survey_ids is required and must contain at least one survey id")
    }
    const data = (await apiForRequest().get(`${SURVEY_PATH}/rating-trends/`, {
      survey_ids: (args["survey_ids"] as unknown[]).map((v) => Number(v)),
      start_date: asString(args["start_date"], "start_date"),
      end_date: asString(args["end_date"], "end_date"),
    })) as Record<string, unknown>
    return envelope(data, `Rating trends for ${(args["survey_ids"] as unknown[]).length} surveys`, [
      "sendsquared_surveys_rollup_report",
    ])
  },
}

export const contactSurveysList: ToolDefinition = {
  name: "sendsquared_contact_surveys_list",
  description:
    "List a contact's survey assignments — which surveys they were sent, the status of each, and their " +
    "responses. contact_id is required; the endpoint does not list assignments across contacts.",
  inputSchema: {
    type: "object",
    required: ["contact_id"],
    properties: {
      contact_id: { type: "number", description: "Contact whose survey assignments to list" },
      limit: { type: "number", description: "Results per page", default: 100 },
      after_id: { type: "number", description: "Pagination cursor: return assignments with id above this", default: 0 },
      survey_id: { type: "number", description: "Restrict to one survey" },
      status: { type: "string", description: "Restrict to a status: pending, sending, completed, errored, cancelled, expired, paused" },
    },
  },
  handler: async (args) => {
    const contactId = asNumber(args["contact_id"], "contact_id")
    const filter = [`contact_id:eq:${contactId}:and`]
    const surveyId = asOptNumber(args["survey_id"])
    if (surveyId !== undefined) filter.push(`survey_id:eq:${surveyId}:and`)
    const status = asOptString(args["status"])
    if (status !== undefined) filter.push(`status:eq:${status}:and`)

    const result = await apiForRequest().list("/contact-surveys", {
      limit: asOptNumber(args["limit"]) ?? 100,
      after_id: asOptNumber(args["after_id"]) ?? 0,
      "filter[]": filter,
    })
    return envelope(
      { assignments: result.data, total: result.total },
      `${result.total} survey assignments for contact ${contactId}`,
      ["sendsquared_contact_surveys_responses", "sendsquared_surveys_assign"],
    )
  },
}

export const contactSurveysResponses: ToolDefinition = {
  name: "sendsquared_contact_surveys_responses",
  description:
    "Fetch one contact's answers to a survey, with z-score comparisons showing how each rating " +
    "compares to the survey average, plus any tasks the response generated.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Contact survey (assignment) id, not the survey id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().get(`/contact-surveys/${encodeURIComponent(id)}/responses`)
    return envelope(data, `Responses for contact survey ${id}`, ["sendsquared_contact_surveys_list"])
  },
}

export const contactSurveysCancel: ToolDefinition = {
  name: "sendsquared_contact_surveys_cancel",
  description:
    "Cancel a contact's pending survey assignment so it is no longer sent or answerable. Destructive — " +
    "there is no undo.",
  inputSchema: {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", description: "Contact survey (assignment) id, not the survey id" } },
  },
  handler: async (args) => {
    const id = asString(args["id"], "id")
    const data = await apiForRequest().delete(`/contact-surveys/${encodeURIComponent(id)}`)
    return envelope(data, `Contact survey ${id} cancelled`, ["sendsquared_contact_surveys_list"])
  },
}

export const surveysResponsesReport: ToolDefinition = {
  name: "sendsquared_surveys_responses_report",
  description:
    "Every assignment of a survey across all contacts created in a window: contact, status (pending, sending, completed, " +
    "errored, cancelled, expired, paused), completion date, and the answer to each question. Includes manual and automated sends. " +
    "Returns by_status counts plus the rows.",
  inputSchema: {
    type: "object",
    required: ["id", "start_date", "end_date"],
    properties: {
      id: { type: "number", description: "Survey id" },
      start_date: { type: "string", description: "YYYY-MM-DD" },
      end_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
      status: { type: "string", description: "Only assignments in this status" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const id = asNumber(args["id"], "id")
    const data = (await apiForRequest().post(
      "/reports/run/survey_responses/0",
      reportRunBody({
        companyId: requestCompanyId(),
        from: asString(args["start_date"], "start_date"),
        to: asString(args["end_date"], "end_date"),
        surveyId: id,
        status: asOptString(args["status"]),
        timezone: asOptString(args["timezone"]),
      }),
    )) as { data?: Array<Record<string, unknown>>; cols?: unknown[] }
    const rows = data.data ?? []
    return envelope({ by_status: countByStatus(rows), rows, cols: data.cols ?? [] }, `${rows.length} assignments of survey ${id}`, [
      "sendsquared_surveys_audit",
    ])
  },
}

/*
  Nothing stores which automation sent a survey, so the audit finds the
  workflows with a step for this survey and runs the automation reports for
  each; those match sends to assignments by contact, survey and a one-day
  window, the same way the web app's automation screens do.
*/
export const surveysAudit: ToolDefinition = {
  name: "sendsquared_surveys_audit",
  description:
    "Audit a survey: which automations send it, and per automation the funnel sent → started → completed for the window " +
    "(per day and per step), plus status counts for every assignment created in the window including manual sends. " +
    "Automation step totals cover at most 31 days.",
  inputSchema: {
    type: "object",
    required: ["id", "start_date", "end_date"],
    properties: {
      id: { type: "number", description: "Survey id" },
      start_date: { type: "string", description: "YYYY-MM-DD" },
      end_date: { type: "string", description: "YYYY-MM-DD, inclusive" },
      timezone: { type: "string" },
    },
  },
  handler: async (args) => {
    const surveyId = asNumber(args["id"], "id")
    const startDate = asString(args["start_date"], "start_date")
    const endDate = asString(args["end_date"], "end_date")
    const timezone = asOptString(args["timezone"])
    const companyId = requestCompanyId()
    const client = apiForRequest()
    const survey = ((await client.get(`${SURVEY_PATH}/${surveyId}`)) ?? {}) as Record<string, unknown>
    const workflows: Array<Record<string, unknown>> = []
    let after = 0
    for (;;) {
      const page = await client.list<Record<string, unknown>>("/workflows", { limit: 100, after_id: after })
      workflows.push(...page.data)
      const last = page.data[page.data.length - 1]
      if (page.data.length < 100 || !last) {
        break
      }
      after = Number(last["id"])
    }
    const senders: Array<Record<string, unknown>> = []
    for (const summary of workflows) {
      const workflowId = Number(summary["id"])
      const workflow = ((await client.get(`/workflows/${workflowId}`)) ?? {}) as Record<string, unknown>
      const steps = workflowSurveySteps(workflow, surveyId)
      if (steps.length === 0) {
        continue
      }
      const base = { companyId, from: startDate, to: endDate, workflowId, timezone }
      const activity = ((await client.post("/reports/run/automation_activity/0", reportRunBody(base))) ?? []) as Array<Record<string, unknown>>
      const performance = ((await client.post("/reports/run/automation_step_performance/0", reportRunBody(base))) ?? []) as Array<Record<string, unknown>>
      const stepIds = new Set(steps.map((s) => s.actionId))
      senders.push({
        workflow_id: workflowId,
        name: workflow["name"],
        active: workflow["active"],
        steps,
        funnel: sumSurveyActivity(activity),
        step_performance: performance.filter((row) => stepIds.has(Number(row["action_id"]))),
        by_day: activity.map((row) => ({
          date: row["report_date"],
          sent: row["surveys_sent"],
          started: row["surveys_started"],
          completed: row["surveys_completed"],
        })),
      })
    }
    const responses = (await client.post(
      "/reports/run/survey_responses/0",
      reportRunBody({ companyId, from: startDate, to: endDate, surveyId, timezone }),
    )) as { data?: Array<Record<string, unknown>> } | undefined
    const rows = responses?.data ?? []
    const automated = senders.reduce((sum, w) => sum + (w["funnel"] as { sent: number }).sent, 0)
    return envelope(
      {
        survey: { id: surveyId, name: survey["name"], active: survey["active"], send_method: survey["send_method"] },
        window: { start: startDate, end: endDate },
        assignments: { total: rows.length, by_status: countByStatus(rows) },
        automations: senders,
        notes: [
          "automation sends are matched to assignments by contact and survey within one day of the step firing",
          "assignments.total counts every assignment created in the window, including manual sends",
        ],
      },
      `Survey ${surveyId}: ${rows.length} assignments in window, ${automated} sent by ${senders.length} automation(s)`,
      ["sendsquared_surveys_responses_report", "sendsquared_reports_automation_detail"],
    )
  },
}

export const surveysTools: ToolDefinition[] = [
  surveysResponsesReport,
  surveysAudit,
  surveysList,
  surveysGet,
  surveysCreate,
  surveysUpdate,
  surveysQuestionsAdd,
  surveysQuestionsUpdate,
  surveysQuestionsRemove,
  surveysQuestionsReorder,
  surveysEndLinksSet,
  surveysTaskConfigsSet,
  surveysDuplicate,
  surveysAssign,
  surveysReport,
  surveysNpsScore,
  surveysTaskReport,
  surveysRollupReport,
  surveysRatingTrends,
  contactSurveysList,
  contactSurveysResponses,
  contactSurveysCancel,
]
