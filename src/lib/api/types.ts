/** Response shapes of the EIP Route Handlers (see docs/frontend-api.md). Dates arrive as ISO strings. */

export type Role = "owner" | "admin" | "staff";
export type Permission =
  | "org.read" | "task.update_status" | "checkin.perform" | "survey.collect"
  | "blueprint.generate" | "proposal.decide" | "event.write" | "attendee.read" | "attendee.write"
  | "survey.manage" | "impact.manage" | "member.manage" | "org.manage" | "budget.read" | "budget.manage" | "data.manage";
export type OrganizerType = "MUNICIPALITY" | "PUBLIC_INSTITUTION" | "UNIVERSITY" | "COMPANY" | "EVENT_AGENCY" | "NONPROFIT" | "OTHER";

export interface Me {
  user: { id: string; email: string | null };
  membership: {
    organization: { id: string; name: string; organizerType: OrganizerType };
    role: Role;
    permissions: Permission[];
  } | null;
}

export type EventStatus = "draft" | "live" | "completed";

export interface EventSummary {
  id: string;
  title: string;
  status: EventStatus;
  startDate: string | null;
  endDate: string | null;
  fromBlueprint: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EventDetail extends EventSummary {
  profile: {
    format: string | null; city: string | null; nuts2Code: string | null; expectedAttendance: number | null;
    objectives: { text: string; origin?: string }[]; modules: { key: string; source?: string; reason?: string | null }[]; audience: string | null;
  } | null;
  modules: { moduleType: string; configuration: Record<string, unknown> }[];
  counts: {
    tasks: Record<string, number>;
    kpis: number;
    surveys: number;
    pendingProposals: number;
    attendees: { total: number; checkedIn: number; cancelled: number };
  };
}

export type TaskStatus = "TODO" | "IN_PROGRESS" | "DONE";
export interface Task {
  id: string; title: string; description: string | null; status: TaskStatus; board: "PLANNING" | "OPERATIONS" | "MEASUREMENT";
  phase: string | null; priority: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | null; workstream: string | null; dueDate: string | null;
  dueOffsetDays: number | null; assigneeRole: string | null; assignedTo: string | null; dependsOn: string[] | null;
  isAiGenerated: boolean; position: number | null; updatedAt: string;
}

export interface Kpi {
  id: string; metricName: string; status: "PROPOSED" | "ACTIVE" | "DROPPED"; dataSource: string | null;
  targetValue: string | number | null; actualValue: string | number | null; objectiveIndex: number | null;
  rationale: string | null; metricVersion: string | null;
}

export type ProposalStatus = "PENDING" | "APPLIED" | "REJECTED" | "FAILED" | "EXPIRED";
export interface ProposalOperation {
  op: "create" | "upsert" | "update";
  entity: string;
  data?: Record<string, unknown>;
  id?: string;
  patch?: Record<string, unknown>;
}
export interface Proposal {
  id: string; kind: string; title: string; rationale: string | null; status: ProposalStatus; eventId: string | null;
  generationId: string | null; appliedOps: number[] | null; appliedSummary: Record<string, unknown> | null; errorMessage: string | null;
  expiresAt: string | null; decidedAt: string | null; createdAt: string; operations: ProposalOperation[];
}

export interface Generation {
  id: string; kind: string; status: "STREAMING" | "SUCCEEDED" | "FAILED_VALIDATION" | "FAILED_PROVIDER" | string;
  eventId: string | null; output: unknown; validationErrors: unknown; done: boolean; quotaExceeded?: boolean;
  /** Provider failure explained: `text` for the organizer, `detail` = provider message (credentials removed). */
  failure?: { kind: string; text: string; detail: string } | null;
  proposals: { id: string; kind: string; status: ProposalStatus }[];
}

export interface Attendee {
  id: string; ticketType: string; isCheckedIn: boolean; checkedInAt: string | null; cancelledAt: string | null; createdAt: string;
}

export interface Ticket { attendeeId: string; ticketType: string; qrToken: string; isCheckedIn: boolean; qrSvg: string }

export interface CheckInSummary {
  eventId: string; total: number; checkedIn: number;
  byTicketType: { ticketType: string; total: number; checkedIn: number }[];
  recent: { attendeeId: string; ticketType: string; checkedInAt: string }[];
  lastCheckedInAt: string | null;
}

export type SurveyStatus = "DRAFT" | "OPEN" | "CLOSED";
export interface SurveySummary {
  id: string; audience: string; version: number; status: SurveyStatus; title: string; targetResponses: number | null;
  opensAt: string | null; closesAt: string | null; questions: number; responses: number; publicToken?: string | null;
}

export interface SurveyQuestion {
  key: string; type: string; text: string; required: boolean; options?: { value: string; label: string }[];
  isSensitive: boolean; helpText?: string; showIf?: { key: string; equals: string | boolean }; spendCategory?: string;
}

export interface SurveyDetail {
  id: string; eventId: string; audience: string; version: number; status: SurveyStatus; title: string; intro: string | null;
  targetResponses: number | null; opensAt: string | null; closesAt: string | null; acceptingResponses: boolean; responses: number;
  publicToken?: string | null; questions: SurveyQuestion[];
}

export interface PublicSurvey { title: string; intro: string | null; audience: string; version: number; questions: SurveyQuestion[] }
/** The event's single survey link: role question first, then the questions of the surveys the chosen option opens. */
export interface PublicEventSurvey {
  eventTitle: string;
  roleQuestion: { text: string; helpText: string; options: { value: string; label: string }[] };
  routes: { key: string; audiences: string[] }[];
  sections: { audience: string; title: string; intro: string | null; version: number; questions: SurveyQuestion[] }[];
}
export interface SurveyRouteInfo { key: string; label: string; audiences: string[] }
export interface EventSurveyLink {
  token: string;
  roleQuestion: string;
  customized: boolean;
  routes: SurveyRouteInfo[];
  surveys: { audience: string; surveyId: string; title: string; version: number; status: SurveyStatus; accepting: boolean; questions: number }[];
}

export interface SurveyResponse {
  id: string; surveyVersion: number; channel: string; answers: Record<string, unknown>; isLocalResident: boolean | null;
  homeProvinceCode: number | null; partySize: number | null; daysPresent: number | null; nightsStayed: number | null;
  wouldVisitAnyway: string | null; isExcluded: boolean; exclusionReason: string | null; submittedAt: string;
  spendKurus: Record<string, number>;
}

export type ImpactLevel = "SPEND" | "ATTRIBUTABLE_SPEND" | "ECONOMIC_IMPACT";
export interface SourcedValue { value: number; source: string }
export type AttributionMethod = "SURVEY_STRICT" | "RECORDED_DEADWEIGHT";
export type ImpactAttribution =
  | { method: "RECORDED_DEADWEIGHT"; deadweight: number; displacement: number }
  | {
    method: "SURVEY_STRICT"; displacement: number; respondents: number; strictRespondentShare: number; strictSpendShare: number;
    shareByCategory: Record<string, number>;
    sensitivity: { rule: "BROAD"; spendShare: number; attributableSpend: number; totalOutputImpact?: number };
  };
export interface ImpactInputs {
  priceYear: number; attributionMethod: AttributionMethod; deadweight: SourcedValue | null; displacement: SourcedValue | null; leakage: SourcedValue | null;
  multiplierSetId: string | null; updatedAt: string;
}
export interface ImpactCheck { level: ImpactLevel; check: string; passed: boolean; required?: number | string; actual?: number | string | null; note?: string }
export interface ImpactReadiness {
  eventId: string; eventStatus: EventStatus;
  inputs: {
    attendance: { basis: "CHECKIN" | "REGISTRATION" | "ORGANIZER_ESTIMATE"; value: number } | null;
    responses: { nonResidentWithSpend: number; withAttributionAnswers: number };
    responseCounts: Record<string, number>;
    eventNuts2Code: string | null; assumptionsRecorded: boolean; assumptions: ImpactInputs | null;
    multiplierSet: { id: string; nuts2Code: string | null; priceYear: number; categories: string[] } | null;
  };
  assessment: { engineVersion: string; requestedLevel: ImpactLevel; achievedLevel: ImpactLevel | null; status: string; checks: ImpactCheck[] };
  figures: null;
  latestRun: { id: string; createdAt: string; achievedLevel: ImpactLevel | null } | null;
  dataNotes: string[];
}
export interface ImpactRun {
  id: string; eventId: string; requestedLevel: ImpactLevel | null; achievedLevel: ImpactLevel | null; status: string; engineVersion: string;
  checks: ImpactCheck[]; inputSnapshot: Record<string, unknown>; multiplierSetId: string | null; attendanceBasis: string | null;
  attendanceUsed: number | null; sampleSize: number | null;
  figures: {
    grossDirectSpend: number | null; attributableSpend: number | null; totalOutputImpact: number | null;
    totalValueAdded: number | null; totalIncome: number | null; totalEmploymentFte: number | null;
  } | null;
  breakdown: {
    visitorShare: number; nonResidentVisitors: number; meanDaysPresent: number; meanSpendPerVisitorDay: number;
    spendSample: number; trimmedOut: number;
    byCategory: Record<string, { gross: number; attributable?: number; output?: number; valueAdded?: number; income?: number; employmentFte?: number }>;
    attribution?: ImpactAttribution;
  } | null;
  triggeredBy: string | null; createdAt: string;
}

export interface MultiplierCoefficient {
  spendCategory: string; a64Code?: string | null; output: number; valueAdded: number; income: number; employmentPerMTry: number | null;
}
export interface MultiplierSet {
  id: string; organizationId: string; name: string; source: string; ioBaseYear: number; priceYear: number; nuts2Code: string | null;
  method: string; multiplierType: string; isActive: boolean; createdAt: string; coefficients: MultiplierCoefficient[];
}

export interface Member {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
  lastSignInAt: string | null;
  isSelf: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  role: "admin" | "staff";
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface PublicInvitation {
  organizationName: string;
  email: string;
  role: "admin" | "staff";
  state: "open" | "expired" | "accepted" | "revoked";
  expiresAt: string;
}

export interface KpiValue {
  id: string;
  value: number | null;
  reason?: "no_data" | "zero_denominator";
  n?: number;
  interval?: [number, number];
  note?: string;
}

export interface KpiActual {
  id: string;
  metricName: string;
  catalogId: string | null;
  computed: KpiValue | null;
  actual: number | null;
  actualSource: "engine" | "manual" | null;
}

export interface EventMetrics {
  engineVersion: string;
  catalogVersion: string;
  computedAt: string;
  values: KpiValue[];
}

export type BudgetKind = "INCOME" | "COST" | "TICKET_ADJUSTMENT";
export interface BudgetItem {
  id: string; eventId: string; kind: BudgetKind; category: string; label: string;
  planned: number | null; actual: number | null; quantity: number | null;
  costBehavior: "FIXED" | "VARIABLE" | null; supplierLocal: boolean | null; fundedExternally: boolean | null;
  notes: string | null; createdAt: string; updatedAt: string;
}
export interface BudgetTotals {
  income: { planned: number | null; actual: number | null; lines: number };
  cost: { planned: number | null; actual: number | null; lines: number };
  ticketAdjustments: { planned: number | null; actual: number | null; lines: number };
  net: { planned: number | null; actual: number | null };
}
export interface Budget { items: BudgetItem[]; totals: BudgetTotals }

export type DataProvider = "OPEN_METEO_AIR" | "BREVO" | "GA4" | "META" | "YOUTUBE" | "NEWS";
export interface DataSourceInfo {
  provider: DataProvider; label: string; feeds: string[]; terms: string; docs: string; envKeys: string[]; missingEnv: string[];
  /** Automatic pulls: provider default and limits (minutes), and the choices offered (0 = off). */
  sync: { defaultMinutes: number; minMinutes: number; maxMinutes: number; note: string; choices: number[] };
  source: null | {
    id: string; config: Record<string, unknown>; enabled: boolean; lastSyncAt: string | null; lastStatus: "OK" | "ERROR" | null;
    lastError: string | null; lastSummary: string | null; observations: number;
    syncIntervalMinutes: number; syncIsDefault: boolean; nextSyncAt: string | null;
  };
}
export interface DataSources {
  event: { city: string | null; startDate: string | null; endDate: string | null; title: string };
  /** Days in which automatic pulls run (60 days before the start → 30 days after the end); null without a start date. */
  window: { from: string; to: string } | null;
  providers: DataSourceInfo[];
}
export interface MediaMention {
  id: string; url: string; title: string | null; domain: string | null; publishedAt: string | null;
  foundBy: "GDELT" | "GOOGLE_NEWS" | "MANUAL"; status: "CANDIDATE" | "VERIFIED" | "REJECTED"; reviewedAt: string | null;
}
export interface UploadSummary {
  sponsors: { rows: number; currentEdition: number; uploadedAt: string | null };
  leads: { rows: number; exhibitors: number; uploadedAt: string | null };
}
export interface CsvUploadResult { stored: number; issues: { line: number; message: string }[]; droppedColumns: string[]; unknownColumns: string[] }

export type DatasetRole = "date" | "group" | "value" | "ignore" | `measure:${string}`;
export interface DatasetColumn {
  key: string; header: string; type: "number" | "date" | "boolean" | "text"; nonEmpty: number; distinct: number;
  stats: { min?: number; max?: number; sum?: number; mean?: number; first?: string; last?: string; top?: { value: string; count: number }[] };
}
export interface DatasetInfo {
  id: string; name: string; fileName: string; sheetName: string | null; status: "NEEDS_REVIEW" | "CONFIRMED"; rowCount: number;
  columns: DatasetColumn[]; mapping: { key: string; role: DatasetRole; source: "rule" | "ai" | "user"; note?: string }[];
  droppedColumns: { header: string; reason: string }[]; suggestedBy: { model?: string; at?: string } | null;
  summary: {
    rows: number;
    numbers: { key: string; header: string; label: string; unit: string; n: number; sum: number; mean: number; min: number; max: number }[];
    booleans: { key: string; header: string; label: string; n: number; trueShare: number }[];
    series: { date: string; values: Record<string, number> }[]; seriesKeys: string[];
    breakdown: { group: string; by: string; items: { label: string; value: number; rows: number }[] } | null;
    period: { first: string; last: string } | null;
  };
  interpretation: { text: string; model: string | null; at: string | null; stale: boolean } | null;
  confirmedAt: string | null; createdAt: string;
}
export interface DatasetUploadResult { id: string; sheets: string[]; sheet: string; rows: number; columns: number; droppedColumns: { header: string; reason: string }[]; notes: string[] }
