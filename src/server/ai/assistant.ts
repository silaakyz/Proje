/**
 * Workspace assistant (read-only). Builds a compact, factual context from the caller's own organization
 * data — read with the same services and RLS as the screens — and lets the model answer questions or draft
 * a management summary from it. The assistant never writes: it can only point the organizer to the screen
 * where a change is made (proposal cards, task board, …), so nothing reaches official records unreviewed.
 */
import "server-only";
import { KPI_BY_ID } from "@/lib/kpi/catalog";
import { formatKpiValue } from "@/lib/ui/format";
import { datasetsContext } from "@/server/datasets/dataset-service";
import { eventKpiActuals, eventKpiValues } from "@/server/analytics/kpi-service";
import { z } from "zod";
import type { OrgAccess, UserDbRunner } from "@/server/auth/org-access";
import { getEventDetail, listEvents } from "@/server/events/events-service";
import { listKpis, listTasks } from "@/server/planning/planning-read";
import { checkInSummary } from "@/server/logistics/checkin";
import { listEventSurveys } from "@/server/surveys/survey-service";
import { impactReadiness, listImpactRuns } from "@/server/analytics/impact-service";
import { METRIC_LIBRARY } from "@/lib/metrics/library";
import { todayIstanbul } from "@/lib/time/istanbul";

export const assistantRequestSchema = z.object({
  organizationId: z.uuid(),
  eventId: z.uuid().nullish(),
  mode: z.enum(["chat", "report"]).default("chat"),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(4000) }))
    .min(1)
    .max(20)
    .refine((m) => m.at(-1)?.role === "user", "the last message must be the user's"),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

const metricName = (key: string) => METRIC_LIBRARY.find((m) => m.key === key)?.name ?? key;

/** A plain-text brief of one event's recorded state (no personal data: tickets and responses are counts). */
export async function eventContext(runAsUser: UserDbRunner, organizationId: string, eventId: string, { finance }: { finance: boolean }) {
  const today = todayIstanbul();
  const [event, tasks, kpis, checkins, surveys, readiness, runs] = await Promise.all([
    getEventDetail(runAsUser, organizationId, eventId),
    listTasks(runAsUser, organizationId, eventId),
    listKpis(runAsUser, organizationId, eventId),
    checkInSummary(organizationId, eventId),
    listEventSurveys(organizationId, eventId, false),
    impactReadiness(organizationId, eventId, "ECONOMIC_IMPACT"),
    listImpactRuns(runAsUser, organizationId, eventId),
  ]);
  const metrics = await eventKpiValues(organizationId, eventId, { finance });
  const ownData = await datasetsContext(organizationId, eventId);
  const kpiActual = new Map((await eventKpiActuals(organizationId, eventId, { finance })).map((a) => [a.id, a]));
  const metricLines = metrics.values
    .filter((m) => m.value !== null)
    .map((m) => {
      const def = KPI_BY_ID.get(m.id)!;
      return `- ${def.name} (${m.id}): ${formatKpiValue(m.value, def.unit, m.id)}${m.n !== undefined ? ` · n=${m.n}` : ""} · kanıt ${def.evidence.join("+")}${m.note ? ` · ${m.note}` : ""}`;
    });
  const open = tasks.filter((t) => t.status !== "DONE");
  const overdue = open.filter((t) => t.dueDate && t.dueDate < today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const upcoming = open.filter((t) => t.dueDate && t.dueDate >= today).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  const line = (t: (typeof tasks)[number]) =>
    `- ${t.title} | son tarih ${t.dueDate ?? "yok"} | ${t.status} | öncelik ${t.priority} | pano ${t.board} | sorumlu ${t.assigneeRole ?? "-"}`;
  const latest = runs[0];

  return [
    `BUGÜN: ${today}`,
    `ETKİNLİK: ${event.title} (id ${event.id})`,
    `Durum: ${event.status} · Tarih: ${event.startDate ?? "belirsiz"} – ${event.endDate ?? event.startDate ?? "belirsiz"}`,
    event.profile
      ? `Profil: format ${String(event.profile.format)}, şehir ${String(event.profile.city ?? "-")}, beklenen katılım ${String(event.profile.expectedAttendance ?? "-")}, hedef kitle ${String(event.profile.audience ?? "-")}`
      : "Profil: plan önerisi olmadan oluşturuldu.",
    event.profile?.objectives?.length ? `Hedefler: ${(event.profile.objectives as { text: string }[]).map((o) => o.text).join(" · ")}` : "",
    `Bekleyen plan önerisi kartı: ${event.counts.pendingProposals}`,
    "",
    `GÖREVLER: toplam ${tasks.length}; TODO ${event.counts.tasks.TODO ?? 0}, IN_PROGRESS ${event.counts.tasks.IN_PROGRESS ?? 0}, DONE ${event.counts.tasks.DONE ?? 0}`,
    `Gecikmiş açık görevler (${overdue.length}):`,
    ...overdue.slice(0, 15).map(line),
    `Yaklaşan açık görevler (ilk 15 / ${upcoming.length}):`,
    ...upcoming.slice(0, 15).map(line),
    "",
    `KPI'LAR (${kpis.length}):`,
    ...kpis.map((k) => {
      const a = kpiActual.get(k.id);
      const actual = a?.actual === null || a?.actual === undefined ? "veri yok" : `${a.actual}${a.actualSource === "manual" ? " (elle girildi)" : " (hesaplandı)"}`;
      return `- ${metricName(k.metricName)} | durum ${k.status} | kaynak ${k.dataSource} | hedef ${k.targetValue ?? "yok"} | gerçekleşen ${actual}`;
    }),
    "",
    `HESAPLANAN METRİKLER (kurum KPI referansı, ${metrics.engineVersion}; K kaynaklı, S standart, T tasarım kararı):`,
    ...metricLines,
    "",
    `KATILIM (gözlenen): geçerli bilet ${checkins.total}, giriş yapan ${checkins.checkedIn}, iptal edilen bilet ${event.counts.attendees.cancelled}`,
    ...checkins.byTicketType.map((t) => `- ${t.ticketType}: ${t.checkedIn}/${t.total}`),
    "",
    `ANKETLER (${surveys.length}):`,
    ...surveys.map((s) => `- ${s.title} | kitle ${s.audience} | durum ${s.status} | ${s.questions} soru | ${s.responses} geçerli yanıt | hedef ${s.targetResponses ?? "yok"}`),
    "",
    "ETKİ HAZIRLIĞI (ekonomik etki seviyesi için kontroller):",
    ...readiness.assessment.checks.map((c) => `- ${c.check}: ${c.passed ? "geçti" : "eksik"}${c.required !== undefined ? ` (gerekli ${c.required}, mevcut ${c.actual ?? "-"})` : ""}`),
    `Ulaşılabilen en yüksek seviye: ${readiness.assessment.achievedLevel ?? "yok"}`,
    latest
      ? `SON HESAPLAMA KAYDI (tahmin, değiştirilemez kayıt ${latest.id}, ${latest.createdAt.toISOString().slice(0, 10)}): ulaşılan seviye ${latest.achievedLevel ?? "yetersiz veri"}; ` +
        `brüt doğrudan harcama ${latest.figures?.grossDirectSpend ?? "-"} TL; atfedilebilir ${latest.figures?.attributableSpend ?? "-"} TL; toplam çıktı etkisi ${latest.figures?.totalOutputImpact ?? "-"} TL; örneklem ${latest.sampleSize ?? 0}`
      : "Kayıtlı etki hesaplaması yok.",
    "",
    ownData.length ? `KURUMUN YÜKLEDİĞİ VERİLER (${ownData.length} tablo; sütun eşleştirmesi kişi tarafından onaylandı):` : "Kurumun yüklediği veri tablosu yok.",
    ...ownData,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

export async function organizationContext(runAsUser: UserDbRunner, org: OrgAccess) {
  const events = await listEvents(runAsUser, org.organizationId);
  return [
    `BUGÜN: ${todayIstanbul()}`,
    `KURUM: ${org.organizationName} (${org.organizerType}), kullanıcının rolü ${org.role}`,
    `ETKİNLİKLER (${events.length}):`,
    ...events.map((e) => `- ${e.title} | durum ${e.status} | ${e.startDate ?? "tarih yok"} – ${e.endDate ?? ""}`),
  ].join("\n");
}

export function assistantSystemPrompt(org: OrgAccess, mode: "chat" | "report", context: string) {
  return `Sen Event Intelligence Platform (EIP) içinde çalışan etkinlik asistanısın. ${org.organizationName} kurumunun ekibine yardım ediyorsun.

KURALLAR
- Yalnızca aşağıdaki KAYITLI VERİ bölümündeki bilgilere dayan. Veride olmayan sayı, tarih, kişi, kurum veya katsayı uydurma; bilmiyorsan "kayıtlarda yok" de.
- Gözlenen veriyi (bilet, check-in, anket yanıt sayıları, görev durumları) tahminden (etki hesaplaması) ayır. Etki rakamlarını her zaman "tahmin" olarak an ve kayıt numarasını belirt; doğrulanmış gerçek gibi sunma.
- Kayıtları değiştiremezsin. Bir değişiklik öneriyorsan, kullanıcının bunu hangi ekrandan yapacağını söyle (Görevler panosu, Öneriler kartları, KPI ve Ölçüm, Katılımcılar, Anketler, Etki). Öneriler resmi kayda ancak yetkili bir kullanıcı onaylarsa geçer.
- Türkçe yaz; sade, profesyonel ve kısa ol. Sayıları Türkçe biçimde yaz (4.820; %65,8; ₺ 12,4 mn). Gerekirse madde işaretleri ve "## " başlıkları kullan; tablo kullanma.
- Kendini tanıtırken "yapay zekâ", "sihir" veya "akıllı" kelimelerini kullanma.
${mode === "report"
    ? `
GÖREV: Yönetim için bir ÖZET RAPOR TASLAĞI yaz. Bölümler: "## Genel durum", "## Katılım", "## Operasyon ve görevler", "## Ölçüm ve anketler", "## Ekonomik etki (tahmin)", "## Eksik veriler ve sonraki adımlar". Her bölüm 2–5 cümle veya madde. Taslak olduğunu ve yetkili onayından önce paylaşılmaması gerektiğini en sonda tek cümleyle belirt.`
    : `
GÖREV: Kullanıcının sorusunu kayıtlı veriye göre yanıtla. Uygunsa en fazla 3 somut sonraki adım öner.`}

KAYITLI VERİ
${context}`;
}
