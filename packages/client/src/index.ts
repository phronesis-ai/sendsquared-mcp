export { request, createClient } from "./request.js"
export type { Client, ClientContext, PageResult, QueryParams, QueryValue } from "./request.js"
export { loginPassword, loginOtp, refreshAuthToken, LoginError } from "./auth.js"
export type { LoginResult, LoginSession, MfaChallenge } from "./auth.js"
export {
  parseConditions,
  parseWorkflowDuration,
  buildWorkflowActionNode,
  stepsToNestedTree,
  appendWorkflowAction,
  removeWorkflowAction,
  emailTemplatePageQuery,
  nextAfterId,
  WorkflowActionType,
} from "./transforms.js"
export type {
  ConditionDef,
  ConditionBlockDef,
  ConditionInput,
  WorkflowActionInput,
  WorkflowActionNode,
  WorkflowStepDef,
  WorkflowEmailOptions,
} from "./transforms.js"
export {
  SurveySendMethod,
  SurveyQuestionType,
  SurveyCalculationType,
  SurveyAlignment,
  SURVEY_SEND_METHODS,
  SURVEY_CONDITION_OPERATORS,
  SURVEY_CONDITION_VALUE_TYPES,
  SURVEY_CONDITION_OPERANDS,
  SURVEY_RESPONSE_OPERANDS,
  SURVEY_ASSIGNMENT_OPERANDS,
  SURVEY_QUESTION_TYPES,
  SURVEY_CALCULATION_TYPES,
  SURVEY_ALIGNMENTS,
  SURVEY_SCALAR_KEYS,
  SURVEY_LOGO_WIDTH_MIN,
  SURVEY_LOGO_WIDTH_MAX,
  normalizeSurveyAnswer,
  normalizeSurveyQuestion,
  normalizeSurveyCondition,
  normalizeSurveyEndLink,
  normalizeSurveyTaskConfig,
  renumberQuestions,
  surveyToPayload,
  mergeSurveyPayload,
  assertSurveyPayload,
} from "./surveys.js"
export type {
  SurveyAnswerInput,
  SurveyQuestionInput,
  SurveyConditionInput,
  SurveyEndLinkInput,
  SurveyTaskConfigInput,
  SurveyPayload,
} from "./surveys.js"
export {
  ImportGroupMode,
  IMPORT_SKIP_COLUMN,
  IMPORT_CUSTOM_FIELD_PREFIX,
  IMPORT_STANDARD_COLUMNS,
  IMPORT_SPECIAL_COLUMNS,
  validateImportColumns,
  suggestImportColumns,
  importStartBody,
  contactCustomFieldNames,
} from "./imports.js"
export type { ImportUploadResult, ImportStartOptions } from "./imports.js"
export {
  AutomationDetailStatus,
  CampaignReportType,
  CAMPAIGN_EMAIL_STATS,
  defaultTimezone,
  companyIdFromToken,
  reportDateRange,
  epochMs,
  reportRunBody,
  workflowSurveySteps,
  sumSurveyActivity,
  countByStatus,
  parseIdList,
  parseOptionalInt,
} from "./reports.js"
export type { ReportRunOptions, WorkflowSurveyStep, SurveyFunnel } from "./reports.js"
export {
  CampaignType,
  CampaignStatus,
  CAMPAIGN_TYPES,
  CAMPAIGN_BUILD_LEAD_MS,
  utmNameFrom,
  campaignActionBody,
  parseSendAt,
  scheduleBody,
  resendWindowError,
  campaignPreflight,
  describeSchedule,
  EmailAttachMode,
  attachEmailTemplate,
  attachCampaignTemplate,
  assertCampaignSender,
} from "./campaigns.js"
export type { CampaignActionInput, CampaignPreflightInput } from "./campaigns.js"
