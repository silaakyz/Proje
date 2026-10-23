"use client";

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { keys, useAttendees, useCheckInStream, useEventDetail, useEventMetrics, useOrg, useSurveys, useTasks } from "@/lib/api/hooks";
import type { SurveyDetail, SurveyResponse } from "@/lib/api/types";
import { PROVINCES } from "@/lib/geo/tr-provinces";
import { formatDecimal, formatNumber, formatPercent, ratio } from "@/lib/ui/format";
import { AUDIENCE_LABEL, TASK_BOARD_LABEL } from "@/lib/ui/labels";
import { EmptyState, SkeletonRows } from "@/components/eip/ui";
import { SectionHeading, useEventId } from "@/components/eip/workspace";
import { MetricsPanel } from "@/components/eip/kpi";
import { OwnDataSection } from "@/components/eip/datasets";

const hourFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", hour12: false, timeZone: "Europe/Istanbul" });
const dayFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", timeZone: "Europe/Istanbul" });
const provinceName = (code: number) => (code === 0 ? "Yurt dışı" : PROVINCES.find((p) => p.code === code)?.name ?? String(code));

function Bars({ rows, unit = "" }: { rows: { label: string; value: number; note?: string }[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="spend-bars analytics-bars">
      {rows.map((r) => (
        <div className="spend-bar-row" key={r.label}>
          <span>{r.label}</span>
          <i><i style={{ width: `${(r.value / max) * 100}%` }} /></i>
          <strong>{r.note ?? `${formatNumber(r.value)}${unit}`}</strong>
        </div>
      ))}
    </div>
  );
}

export default function AnalyticsPage() {
  const eventId = useEventId();
  const { orgId, can } = useOrg();
  const event = useEventDetail(eventId);
  const tasks = useTasks(eventId);
  const checkins = useCheckInStream(eventId, can("checkin.perform"));
  const attendees = useAttendees(eventId, can("attendee.read"));
  const surveys = useSurveys(eventId);
  const metrics = useEventMetrics(eventId);
  const [showEmpty, setShowEmpty] = useState(false);
  const canResponses = can("survey.manage");
  const surveyIds = (surveys.data ?? []).filter((s) => s.responses > 0).map((s) => s.id);
  const details = useQueries({
    queries: surveyIds.map((id) => ({
      queryKey: keys.survey(id),
      queryFn: () => api<{ survey: SurveyDetail }>(`/api/surveys/${id}`, { query: { organizationId: orgId } }).then((r) => r.survey),
      enabled: !!orgId,
    })),
  });
  const responses = useQueries({
    queries: surveyIds.map((id) => ({
      queryKey: keys.responses(id),
      queryFn: () => api<{ responses: SurveyResponse[] }>(`/api/surveys/${id}/responses`, { query: { organizationId: orgId } }).then((r) => r.responses),
      enabled: !!orgId && canResponses,
    })),
  });

  // Entry peaks: check-ins per day-hour (observed).
  const peaks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of attendees.data ?? []) {
      if (!a.checkedInAt || a.cancelledAt) continue;
      const d = new Date(a.checkedInAt);
      const key = `${dayFmt.format(d)} · ${hourFmt.format(d)}.00`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 6);
  }, [attendees.data]);

  // Survey: scale-question means and visitor profile, from non-excluded responses (observed).
  const surveyStats = useMemo(() => {
    const out: { title: string; audience: string; n: number; scales: { text: string; mean: number; n: number; max: number }[] }[] = [];
    let local = 0;
    let visitor = 0;
    const provinces = new Map<number, number>();
    surveyIds.forEach((_id, i) => {
      const d = details[i]?.data;
      const rs = (responses[i]?.data ?? []).filter((r) => !r.isExcluded);
      if (!d) return;
      const scales = d.questions
        .filter((q) => ["LIKERT_5", "rating", "NPS_0_10"].includes(q.type))
        .map((q) => {
          const vals = rs.map((r) => r.answers[q.key]).filter((v): v is number => typeof v === "number");
          return { text: q.text, n: vals.length, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0, max: q.type === "NPS_0_10" ? 10 : 5 };
        })
        .filter((s) => s.n > 0);
      out.push({ title: d.title, audience: d.audience, n: rs.length, scales });
      for (const r of rs) {
        if (r.isLocalResident === true) local++;
        if (r.isLocalResident === false) visitor++;
        if (r.homeProvinceCode !== null && r.isLocalResident === false) provinces.set(r.homeProvinceCode, (provinces.get(r.homeProvinceCode) ?? 0) + 1);
      }
    });
    const topProvinces = [...provinces.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([code, value]) => ({ label: provinceName(code), value }));
    return { surveys: out, local, visitor, topProvinces };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surveyIds.join(","), details.map((d) => d.dataUpdatedAt).join(","), responses.map((r) => r.dataUpdatedAt).join(",")]);

  const byBoard = ["PLANNING", "OPERATIONS", "MEASUREMENT"].map((b) => {
    const ts = (tasks.data ?? []).filter((t) => t.board === b);
    return { label: TASK_BOARD_LABEL[b]!, value: ts.filter((t) => t.status === "DONE").length, total: ts.length };
  }).filter((b) => b.total > 0);

  const s = checkins.data;
  const counts = event.data?.counts;
  const loading = event.isPending || tasks.isPending || surveys.isPending;
  const surveyDataPending = details.some((d) => d.isPending) || (canResponses && responses.some((r) => r.isPending));

  if (loading) return <SkeletonRows rows={5} label="Analizler yükleniyor" />;

  return (
    <div className="analytics-content">
      <section className="placeholder-hero">
        <p className="eyebrow">ANALİZLER</p>
        <h2>Gözlenen veriler</h2>
        <p>Bu sayfadaki her değer kayıtlı bilet, check-in, görev ve anket verilerinden anlık hesaplanır. Anketten nüfusa yapılan tahminler (ör. brüt ziyaretçi harcaması) belirtilir; çarpanlı ekonomik etki Etki sekmesindedir.</p>
      </section>

      <div className="placeholder-preview-grid overview-stats">
        <article>
          <span>Giriş oranı</span>
          <p>
            <strong>{s ? formatPercent(s.checkedIn, s.total) : counts ? formatPercent(counts.attendees.checkedIn, counts.attendees.total) : "—"}</strong>
            <small>{formatNumber(s?.checkedIn ?? counts?.attendees.checkedIn ?? 0)} / {formatNumber(s?.total ?? counts?.attendees.total ?? 0)} bilet</small>
          </p>
        </article>
        <article>
          <span>Anket yanıtı</span>
          <p>
            <strong>{formatNumber((surveys.data ?? []).reduce((n, x) => n + x.responses, 0))}</strong>
            <small>{(surveys.data ?? []).filter((x) => x.status === "OPEN").length} açık anket</small>
          </p>
        </article>
        <article>
          <span>Görev tamamlama</span>
          <p>
            <strong>{formatPercent(counts?.tasks.DONE ?? 0, (counts?.tasks.TODO ?? 0) + (counts?.tasks.IN_PROGRESS ?? 0) + (counts?.tasks.DONE ?? 0))}</strong>
            <small>{formatNumber(counts?.tasks.DONE ?? 0)} görev tamamlandı</small>
          </p>
        </article>
      </div>

      <section className="analytics-surveys">
        <SectionHeading eyebrow="KPI SONUÇLARI" title="Kurum KPI referansına göre">
          <button className="text-button" type="button" onClick={() => setShowEmpty((x) => !x)}>
            {showEmpty ? "Veri olmayanları gizle" : "Veri olmayanları da göster"}
          </button>
        </SectionHeading>
        <p className="section-intro">
          Formüller kurumunuzun "Etkinlik Etki Analizi — KPI ve Formül Referansı" belgesinden alınır. K: kaynaktan doğrulandı, S: standart tanım,
          T: tasarım kararı. Anket değerleri ağırlıklıdır; n geçerli yanıt sayısıdır. Tüm metrikler ve gerekli veriler Metrik Kataloğu sayfasındadır.
        </p>
        {metrics.isPending ? (
          <SkeletonRows rows={3} label="KPI'lar hesaplanıyor" />
        ) : metrics.data ? (
          <MetricsPanel values={metrics.data.values} hideEmpty={!showEmpty} />
        ) : (
          <p className="muted-text">KPI değerleri hesaplanamadı.</p>
        )}
      </section>

      <OwnDataSection eventId={eventId} />

      <div className="overview-columns">
        <section>
          <SectionHeading eyebrow="KATILIM" title="Bilet türüne göre giriş" />
          {s && s.byTicketType.length ? (
            <Bars rows={s.byTicketType.map((t) => ({ label: t.ticketType, value: t.checkedIn, note: `${formatNumber(t.checkedIn)} / ${formatNumber(t.total)} · %${formatDecimal(Math.round(ratio(t.checkedIn, t.total) * 10) / 10)}` }))} />
          ) : (
            <p className="muted-text">Henüz bilet veya giriş yok.</p>
          )}
          {peaks.length > 0 && (
            <>
              <h3 className="sub-heading">Yoğun giriş saatleri</h3>
              <Bars rows={peaks} unit=" giriş" />
            </>
          )}
        </section>

        <section>
          <SectionHeading eyebrow="ZİYARETÇİ PROFİLİ" title="Anket yanıtlarından" />
          {!canResponses ? (
            <p className="muted-text">Yanıt ayrıntıları kurum sahibi ve yöneticilere açıktır.</p>
          ) : surveyDataPending ? (
            <SkeletonRows rows={2} label="Yanıtlar yükleniyor" />
          ) : surveyStats.local + surveyStats.visitor === 0 ? (
            <p className="muted-text">Profil sorusunu yanıtlayan ziyaretçi henüz yok.</p>
          ) : (
            <>
              <Bars
                rows={[
                  { label: "Şehir dışından", value: surveyStats.visitor, note: `${formatNumber(surveyStats.visitor)} · ${formatPercent(surveyStats.visitor, surveyStats.local + surveyStats.visitor)}` },
                  { label: "Yerel", value: surveyStats.local, note: `${formatNumber(surveyStats.local)} · ${formatPercent(surveyStats.local, surveyStats.local + surveyStats.visitor)}` },
                ]}
              />
              {surveyStats.topProvinces.length > 0 && (
                <>
                  <h3 className="sub-heading">Ziyaretçilerin geldiği iller</h3>
                  <Bars rows={surveyStats.topProvinces} unit=" yanıt" />
                </>
              )}
            </>
          )}
        </section>
      </div>

      <section className="analytics-surveys">
        <SectionHeading eyebrow="ANKET BULGULARI" title="Ölçek sorularının ortalamaları" />
        {!canResponses ? (
          <p className="muted-text">Yanıt ayrıntıları kurum sahibi ve yöneticilere açıktır.</p>
        ) : surveyDataPending ? (
          <SkeletonRows rows={2} label="Yanıtlar yükleniyor" />
        ) : surveyStats.surveys.length === 0 ? (
          <EmptyState title="Yanıtı olan anket yok." />
        ) : (
          surveyStats.surveys.map((x) => (
            <div className="analytics-survey" key={x.title}>
              <h3>
                {x.title} <small>{AUDIENCE_LABEL[x.audience] ?? x.audience} · {formatNumber(x.n)} geçerli yanıt</small>
              </h3>
              {x.scales.length === 0 ? (
                <p className="muted-text">Bu ankette ölçek sorusu yok.</p>
              ) : (
                <Bars rows={x.scales.map((q) => ({ label: q.text, value: q.mean / q.max, note: `${formatDecimal(Math.round(q.mean * 10) / 10)} / ${q.max} · n=${formatNumber(q.n)}` }))} />
              )}
            </div>
          ))
        )}
      </section>

      {byBoard.length > 0 && (
        <section className="analytics-surveys">
          <SectionHeading eyebrow="OPERASYON" title="Panoya göre tamamlanan görevler" />
          <Bars rows={byBoard.map((b) => ({ label: b.label, value: b.value / b.total, note: `${formatNumber(b.value)} / ${formatNumber(b.total)}` }))} />
        </section>
      )}
    </div>
  );
}
