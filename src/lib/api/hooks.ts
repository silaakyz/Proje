"use client";
/**
 * Server state (TanStack Query). The organization id comes from /api/me; every organization-scoped
 * request carries it. Mutations invalidate exactly the queries they change.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  Attendee, Budget, CheckInSummary, DataSources, DatasetInfo, MediaMention, UploadSummary, EventDetail, EventStatus, EventSummary, ImpactInputs, ImpactLevel, ImpactReadiness, ImpactRun, Kpi, Me,
  EventMetrics, Invitation, KpiActual, Member, MultiplierSet, Permission, Proposal, SurveyDetail, SurveyResponse, SurveySummary, Task, TaskStatus, EventSurveyLink, Registration, RegistrationForm } from "@/lib/api/types";

export const keys = {
  me: ["me"] as const,
  events: (org: string) => ["events", org] as const,
  event: (org: string, id: string) => ["event", org, id] as const,
  tasks: (id: string) => ["tasks", id] as const,
  kpis: (id: string) => ["kpis", id] as const,
  proposals: (id: string | "none") => ["proposals", id] as const,
  attendees: (id: string) => ["attendees", id] as const,
  checkins: (id: string) => ["checkins", id] as const,
  surveys: (id: string) => ["surveys", id] as const,
  survey: (id: string) => ["survey", id] as const,
  responses: (id: string) => ["responses", id] as const,
  impact: (id: string, level: string) => ["impact", id, level] as const,
  impactInputs: (id: string) => ["impactInputs", id] as const,
  impactRuns: (id: string) => ["impactRuns", id] as const,
  multiplierSets: (org: string) => ["multiplierSets", org] as const,
  members: (org: string) => ["members", org] as const,
  metrics: (id: string) => ["metrics", id] as const,
  invitations: (org: string) => ["invitations", org] as const,
  archivedEvents: (org: string) => ["events", org, "archived"] as const,
  budget: (id: string) => ["budget", id] as const,
  dataSources: (id: string) => ["data-sources", id] as const,
  mentions: (id: string) => ["mentions", id] as const,
  uploads: (id: string) => ["uploads", id] as const,
  datasets: (id: string) => ["datasets", id] as const,
};

export function useMe() {
  return useQuery({ queryKey: keys.me, queryFn: ({ signal }) => api<Me>("/api/me", { signal }), staleTime: 60_000 });
}

/** The signed-in member's organization; components below the app shell can rely on it being loaded. */
export function useOrg() {
  const me = useMe();
  const m = me.data?.membership ?? null;
  return {
    orgId: m?.organization.id ?? "",
    orgName: m?.organization.name ?? "",
    role: m?.role ?? null,
    email: me.data?.user.email ?? null,
    can: (p: Permission) => !!m?.permissions.includes(p),
    loaded: !!m,
  };
}


export function useEvents() {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.events(orgId),
    enabled: !!orgId,
    queryFn: ({ signal }) => api<{ events: EventSummary[] }>("/api/events", { query: { organizationId: orgId }, signal }).then((r) => r.events),
  });
}

export function useArchivedEvents(enabled: boolean) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.archivedEvents(orgId),
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) =>
      api<{ events: EventSummary[] }>("/api/events", { query: { organizationId: orgId, archived: "1" }, signal }).then((r) => r.events),
  });
}

export function useMembers() {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.members(orgId),
    enabled: !!orgId,
    queryFn: ({ signal }) => api<{ members: Member[] }>("/api/org/members", { query: { organizationId: orgId }, signal }).then((r) => r.members),
  });
}

export function useInvitations(enabled: boolean) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.invitations(orgId),
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) =>
      api<{ invitations: Invitation[] }>("/api/org/invitations", { query: { organizationId: orgId }, signal }).then((r) => r.invitations),
  });
}

export function useEventDetail(eventId: string | null | undefined) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.event(orgId, eventId ?? ""),
    enabled: !!orgId && !!eventId,
    queryFn: ({ signal }) =>
      api<{ event: EventDetail }>(`/api/events/${eventId}`, { query: { organizationId: orgId }, signal }).then((r) => r.event),
  });
}

export function useTasks(eventId: string | null | undefined) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.tasks(eventId ?? ""),
    enabled: !!orgId && !!eventId,
    queryFn: ({ signal }) => api<{ tasks: Task[] }>(`/api/events/${eventId}/tasks`, { query: { organizationId: orgId }, signal }).then((r) => r.tasks),
  });
}

export function useKpis(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.kpis(eventId),
    enabled: !!orgId,
    queryFn: ({ signal }) => api<{ kpis: Kpi[]; actuals: KpiActual[] }>(`/api/events/${eventId}/kpis`, { query: { organizationId: orgId }, signal }),
  });
}

/** Budget lines and totals (budget.read: owner, admin). */
export function useBudget(eventId: string) {
  const { orgId, can } = useOrg();
  return useQuery({
    queryKey: keys.budget(eventId),
    enabled: !!orgId && !!eventId && can("budget.read"),
    queryFn: ({ signal }) => api<Budget>(`/api/events/${eventId}/budget`, { query: { organizationId: orgId }, signal }),
  });
}

/** External data sources of an event (every provider, configured or not). */
export function useDataSources(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.dataSources(eventId),
    enabled: !!orgId && !!eventId,
    queryFn: ({ signal }) => api<DataSources>(`/api/events/${eventId}/data-sources`, { query: { organizationId: orgId }, signal }),
  });
}

export function useMentions(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.mentions(eventId),
    enabled: !!orgId && !!eventId,
    queryFn: ({ signal }) => api<{ mentions: MediaMention[] }>(`/api/events/${eventId}/mentions`, { query: { organizationId: orgId }, signal }).then((r) => r.mentions),
  });
}

/** Row counts of the sponsor / lead uploads (data.manage). */
export function useUploads(eventId: string) {
  const { orgId, can } = useOrg();
  return useQuery({
    queryKey: keys.uploads(eventId),
    enabled: !!orgId && !!eventId && can("data.manage"),
    queryFn: ({ signal }) => api<UploadSummary>(`/api/events/${eventId}/uploads`, { query: { organizationId: orgId }, signal }),
  });
}

/** The organization's own uploaded tables for the event (summaries, no rows). */
export function useDatasets(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.datasets(eventId),
    enabled: !!orgId && !!eventId,
    queryFn: ({ signal }) => api<{ datasets: DatasetInfo[]; aiAvailable: boolean }>(`/api/events/${eventId}/datasets`, { query: { organizationId: orgId }, signal }),
  });
}

/** Every KPI the platform computes for the event (organization's KPI reference). */
export function useEventMetrics(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.metrics(eventId),
    enabled: !!orgId && !!eventId,
    queryFn: ({ signal }) => api<EventMetrics>(`/api/events/${eventId}/metrics`, { query: { organizationId: orgId }, signal }),
  });
}

export function useProposals(eventId: string | "none", opts: { poll?: number | false } = {}) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.proposals(eventId),
    enabled: !!orgId,
    refetchInterval: opts.poll ?? false,
    queryFn: ({ signal }) =>
      api<{ proposals: Proposal[] }>("/api/proposals", { query: { organizationId: orgId, eventId }, signal }).then((r) => r.proposals),
  });
}

export function useAttendees(eventId: string, enabled = true) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.attendees(eventId),
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) =>
      api<{ attendees: Attendee[] }>(`/api/events/${eventId}/attendees`, { query: { organizationId: orgId }, signal }).then((r) => r.attendees),
  });
}

/** The event's public registration form (attendee.write) and its registrations (attendee.read). */
export function useRegistrationForm(eventId: string, enabled: boolean) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: ["registration-form", eventId],
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) => api<{ form: RegistrationForm }>(`/api/events/${eventId}/registration-form`, { query: { organizationId: orgId }, signal }).then((r) => r.form),
  });
}
export function useRegistrations(eventId: string, enabled: boolean) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: ["registrations", eventId],
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) => api<{ registrations: Registration[] }>(`/api/events/${eventId}/registrations`, { query: { organizationId: orgId }, signal }).then((r) => r.registrations),
  });
}

/** What the sign-in page offers (public): open or invite-only sign-up, password reset by e-mail (= e-mail configured). */
export function useAuthOptions() {
  return useQuery({
    queryKey: ["auth-options"],
    queryFn: ({ signal }) => api<{ signUp: "open" | "invite"; passwordReset: boolean }>("/api/auth/options", { signal }),
    staleTime: 5 * 60_000,
  });
}

/** The event's single survey link (survey.manage). Under the surveys key, so survey changes refresh it. */
export function useSurveyLink(eventId: string, enabled: boolean) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: [...keys.surveys(eventId), "link"],
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) =>
      api<{ link: EventSurveyLink }>(`/api/events/${eventId}/survey-link`, { query: { organizationId: orgId }, signal }).then((r) => r.link),
  });
}

export function useSurveys(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.surveys(eventId),
    enabled: !!orgId,
    queryFn: ({ signal }) =>
      api<{ surveys: SurveySummary[] }>(`/api/events/${eventId}/surveys`, { query: { organizationId: orgId }, signal }).then((r) => r.surveys),
  });
}

export function useSurvey(surveyId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.survey(surveyId),
    enabled: !!orgId,
    queryFn: ({ signal }) => api<{ survey: SurveyDetail }>(`/api/surveys/${surveyId}`, { query: { organizationId: orgId }, signal }).then((r) => r.survey),
  });
}

export function useResponses(surveyId: string, enabled: boolean) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.responses(surveyId),
    enabled: !!orgId && enabled,
    queryFn: ({ signal }) =>
      api<{ responses: SurveyResponse[] }>(`/api/surveys/${surveyId}/responses`, { query: { organizationId: orgId }, signal }).then((r) => r.responses),
  });
}

export function useImpact(eventId: string, level: ImpactLevel) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.impact(eventId, level),
    enabled: !!orgId,
    queryFn: ({ signal }) =>
      api<{ impact: ImpactReadiness }>(`/api/events/${eventId}/impact`, { query: { organizationId: orgId, level }, signal }).then((r) => r.impact),
  });
}

export function useImpactInputs(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.impactInputs(eventId),
    enabled: !!orgId,
    queryFn: ({ signal }) =>
      api<{ inputs: ImpactInputs | null }>(`/api/events/${eventId}/impact/inputs`, { query: { organizationId: orgId }, signal }).then((r) => r.inputs),
  });
}

export function useImpactRuns(eventId: string) {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.impactRuns(eventId),
    enabled: !!orgId,
    queryFn: ({ signal }) =>
      api<{ runs: ImpactRun[] }>(`/api/events/${eventId}/impact/runs`, { query: { organizationId: orgId }, signal }).then((r) => r.runs),
  });
}

export function useMultiplierSets() {
  const { orgId } = useOrg();
  return useQuery({
    queryKey: keys.multiplierSets(orgId),
    enabled: !!orgId,
    queryFn: ({ signal }) =>
      api<{ multiplierSets: MultiplierSet[] }>("/api/multiplier-sets", { query: { organizationId: orgId }, signal }).then((r) => r.multiplierSets),
  });
}

/**
 * Live check-in counter: GET …/checkins for the first paint, then the SSE stream keeps the cached summary
 * current (EventSource reconnects by itself after the server closes the stream). `connected` is false while
 * the stream is down.
 */
export function useCheckInStream(eventId: string | null | undefined, enabled: boolean) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const [connected, setConnected] = useState(true);
  const query = useQuery({
    queryKey: keys.checkins(eventId ?? ""),
    enabled: !!orgId && !!eventId && enabled,
    queryFn: ({ signal }) =>
      api<{ summary: CheckInSummary }>(`/api/events/${eventId}/checkins`, { query: { organizationId: orgId }, signal }).then((r) => r.summary),
  });
  useEffect(() => {
    if (!orgId || !eventId || !enabled || typeof EventSource === "undefined") return;
    const es = new EventSource(`/api/events/${eventId}/checkins/stream?organizationId=${encodeURIComponent(orgId)}`);
    const onSummary = (e: MessageEvent) => {
      setConnected(true);
      try {
        const s = JSON.parse(e.data) as CheckInSummary;
        qc.setQueryData(keys.checkins(eventId), s);
      } catch {
        /* ignore malformed frames */
      }
    };
    es.addEventListener("summary", onSummary as EventListener);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => {
      es.removeEventListener("summary", onSummary as EventListener);
      es.close();
    };
  }, [orgId, eventId, enabled, qc]);
  return { ...query, connected };
}

// ------------------------------------------------------------------------------------------- mutations

/** A mutation that sends `organizationId` with the body and invalidates the given keys on success. */
export function useOrgMutation<TVars, TResult = unknown>(
  request: (orgId: string, vars: TVars) => Promise<TResult>,
  invalidate: (vars: TVars, result: TResult) => QueryKey[],
) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: TVars) => request(orgId, vars),
    onSuccess: async (result, vars) => {
      await Promise.all(invalidate(vars, result).map((queryKey) => qc.invalidateQueries({ queryKey })));
    },
  });
}

export function useUpdateTaskStatus(eventId: string) {
  return useOrgMutation(
    (organizationId, v: { taskId: string; status: TaskStatus }) =>
      api(`/api/tasks/${v.taskId}`, { method: "PATCH", body: { organizationId, status: v.status } }),
    () => [keys.tasks(eventId), ["event"]],
  );
}

export function useUpdateEvent(eventId: string) {
  return useOrgMutation(
    (organizationId, v: { title?: string; status?: EventStatus; startDate?: string | null; endDate?: string | null }) =>
      api<{ event: EventSummary }>(`/api/events/${eventId}`, { method: "PATCH", body: { organizationId, ...v } }),
    () => [["event"], ["events"], keys.tasks(eventId)],
  );
}
