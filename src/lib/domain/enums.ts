/**
 * Domain string unions, usable in client bundles and Zod schemas. The ones stored as database enums
 * generate them in src/db/schema.ts; the blueprint unit test asserts they match the latest Drizzle
 * migration snapshot. The others live in events.ai_config / code only.
 */
/** What kind of event it is. */
export const EVENT_FORMATS = [
  "CONFERENCE", "SYMPOSIUM", "SUMMIT", "CONGRESS", "B2B_MATCHMAKING", "CULTURAL",
  "TRADE_FAIR", "FESTIVAL", "CONCERT", "SPORTS", "WORKSHOP", "MEETUP", "EXHIBITION", "OTHER",
] as const;
export type EventFormatValue = (typeof EVENT_FORMATS)[number];

/** How people attend. */
export const DELIVERY_MODES = ["IN_PERSON", "HYBRID", "VIRTUAL"] as const;
export type DeliveryModeValue = (typeof DELIVERY_MODES)[number];

/** Who organizes. Independent of format. */
export const ORGANIZER_TYPES = [
  "MUNICIPALITY", "PUBLIC_INSTITUTION", "UNIVERSITY", "COMPANY", "EVENT_AGENCY", "NONPROFIT", "OTHER",
] as const;
export type OrganizerTypeValue = (typeof ORGANIZER_TYPES)[number];

export const EVENT_PHASES = ["PLAN", "PREPARE", "MANAGE", "RUN", "ANALYZE", "IMPROVE"] as const;
export type EventPhaseValue = (typeof EVENT_PHASES)[number];

export const STAKEHOLDER_KINDS = [
  "SPONSOR", "PARTNER", "VENDOR", "SPEAKER", "EXHIBITOR", "ARTIST", "PUBLIC_AUTHORITY",
  "LOCAL_BUSINESS", "MEDIA", "VOLUNTEER_GROUP", "COMMUNITY", "OTHER",
] as const;
export type StakeholderKindValue = (typeof STAKEHOLDER_KINDS)[number];

export const SURVEY_AUDIENCES = [
  "ATTENDEE", "SPONSOR", "EXHIBITOR", "LOCAL_BUSINESS", "ORGANIZER", "RESIDENT", "PUBLIC_AUTHORITY",
] as const;
export type SurveyAudienceValue = (typeof SURVEY_AUDIENCES)[number];

export const TASK_BOARDS = ["PLANNING", "OPERATIONS", "MEASUREMENT"] as const;
export const TASK_PRIORITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const;

export const METRIC_CATEGORIES = [
  "ATTENDANCE", "EXPERIENCE", "ENGAGEMENT", "ECONOMIC", "SOCIAL", "MEDIA", "OPERATIONS", "ENVIRONMENT", "COMMERCIAL",
] as const;
export type MetricCategoryValue = (typeof METRIC_CATEGORIES)[number];

export const METRIC_DATA_SOURCES = [
  "REGISTRATION", "CHECKIN", "SURVEY", "MANUAL_ENTRY", "FILE_UPLOAD", "SOCIAL_MEDIA", "EXTERNAL_API", "FINANCE",
] as const;
export type MetricDataSourceValue = (typeof METRIC_DATA_SOURCES)[number];
