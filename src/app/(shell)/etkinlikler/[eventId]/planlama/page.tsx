"use client";

import { useMemo } from "react";
import { useEventDetail, useTasks } from "@/lib/api/hooks";
import { daysUntil, formatDate, formatNumber } from "@/lib/ui/format";
import { PHASE_LABEL, PRIORITY_LABEL, TASK_BOARD_LABEL, TASK_STATUS_LABEL } from "@/lib/ui/labels";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/eip/ui";
import { SectionHeading, useEventId } from "@/components/eip/workspace";

const monthFmt = new Intl.DateTimeFormat("tr-TR", { month: "long", year: "numeric", timeZone: "UTC" });
const PHASES = ["PLAN", "PREPARE", "MANAGE", "RUN", "ANALYZE", "IMPROVE"];

export default function PlanningPage() {
  const eventId = useEventId();
  const event = useEventDetail(eventId);
  const tasks = useTasks(eventId);

  const months = useMemo(() => {
    const dated = (tasks.data ?? []).filter((t) => t.dueDate).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
    const groups = new Map<string, typeof dated>();
    for (const t of dated) {
      const key = t.dueDate!.slice(0, 7);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
    }
    return [...groups.entries()];
  }, [tasks.data]);
  const undated = (tasks.data ?? []).filter((t) => !t.dueDate);
  const phases = PHASES.map((p) => {
    const ts = (tasks.data ?? []).filter((t) => t.phase === p);
    return { phase: p, total: ts.length, done: ts.filter((t) => t.status === "DONE").length };
  }).filter((p) => p.total > 0);

  const e = event.data;
  const milestones = [
    ...(e?.startDate ? [{ date: e.startDate, title: "Etkinlik başlangıcı", kind: "event" }] : []),
    ...(e?.endDate && e.endDate !== e.startDate ? [{ date: e.endDate, title: "Etkinlik bitişi", kind: "event" }] : []),
    ...(tasks.data ?? []).filter((t) => t.priority === "CRITICAL" && t.dueDate).map((t) => ({ date: t.dueDate!, title: t.title, kind: "critical" })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  if (tasks.isPending) return <SkeletonRows rows={5} label="Plan yükleniyor" />;
  if (tasks.isError) return <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />;

  return (
    <div className="timeline-content">
      <section className="placeholder-hero">
        <p className="eyebrow">PLANLAMA</p>
        <h2>Takvim ve kilometre taşları</h2>
        <p>
          Hazırlık dönemini görev son tarihleriyle izleyin. Plan önerisinden gelen görevler etkinlik başlangıcına göre konumlanır;
          başlangıç tarihi değişince birlikte kayar.
        </p>
      </section>

      {phases.length > 0 && (
        <div className="phase-strip" aria-label="Aşamalara göre ilerleme">
          {phases.map((p) => (
            <div key={p.phase}>
              <span>{PHASE_LABEL[p.phase] ?? p.phase}</span>
              <strong>{formatNumber(p.done)} / {formatNumber(p.total)}</strong>
              <i aria-hidden="true"><i style={{ width: `${(p.done / p.total) * 100}%` }} /></i>
            </div>
          ))}
        </div>
      )}

      {milestones.length > 0 && (
        <section className="milestones">
          <SectionHeading eyebrow="KİLOMETRE TAŞLARI" title="Kritik tarihler" />
          {milestones.map((m, i) => {
            const d = daysUntil(m.date);
            return (
              <div className={`milestone-row milestone-${m.kind}`} key={`${m.date}-${i}`}>
                <time>{formatDate(m.date)}</time>
                <strong>{m.title}</strong>
                <span>{d === 0 ? "bugün" : d > 0 ? `${d} gün kaldı` : `${-d} gün önce`}</span>
              </div>
            );
          })}
        </section>
      )}

      {months.length === 0 && undated.length === 0 ? (
        <EmptyState title="Takvim için görev yok. Plan önerilerinden görev kartını uygulayın." />
      ) : (
        <section className="timeline">
          <SectionHeading eyebrow="TAKVİM" title="Görev takvimi" />
          {months.map(([month, ts]) => (
            <div className="timeline-month" key={month}>
              <h3>{monthFmt.format(new Date(`${month}-15T12:00:00Z`))}</h3>
              {ts.map((t) => {
                const d = daysUntil(t.dueDate!);
                const tone = t.status === "DONE" ? "done" : d < 0 ? "overdue" : d <= 3 ? "soon" : "";
                return (
                  <div className={`timeline-row ${tone}`} key={t.id}>
                    <time>{formatDate(t.dueDate, true)}</time>
                    <strong>{t.title}</strong>
                    <span>{TASK_BOARD_LABEL[t.board]} · {t.priority ? PRIORITY_LABEL[t.priority] : ""}</span>
                    <em>{TASK_STATUS_LABEL[t.status]}</em>
                  </div>
                );
              })}
            </div>
          ))}
          {undated.length > 0 && (
            <div className="timeline-month">
              <h3>Tarihi belirlenmemiş</h3>
              {undated.map((t) => (
                <div className="timeline-row" key={t.id}>
                  <time>—</time>
                  <strong>{t.title}</strong>
                  <span>{TASK_BOARD_LABEL[t.board]}</span>
                  <em>{TASK_STATUS_LABEL[t.status]}</em>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
