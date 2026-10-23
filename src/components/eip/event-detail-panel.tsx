"use client";
/** The selected-event panel of the dashboard: live attendance, task split and counters, all from the API. */
import { useRouter } from "next/navigation";
import { useCheckInStream, useEventDetail, useOrg } from "@/lib/api/hooks";
import type { EventSummary } from "@/lib/api/types";
import { formatDateRange, formatNumber, formatPercent, ratio } from "@/lib/ui/format";
import { EVENT_FORMAT_LABEL, EVENT_STATUS_BADGE } from "@/lib/ui/labels";
import { AppIcon, ErrorState, StatusBadge } from "@/components/eip/ui";

export function EventDetailPanel({ event, fullPage = false, onBack }: { event: EventSummary; fullPage?: boolean; onBack?: () => void }) {
  const router = useRouter();
  const { can } = useOrg();
  const detail = useEventDetail(event.id);
  const live = event.status === "live" && can("checkin.perform");
  const checkins = useCheckInStream(event.id, live);
  const d = detail.data;

  const total = live && checkins.data ? checkins.data.total : (d?.counts.attendees.total ?? 0);
  const checkedIn = live && checkins.data ? checkins.data.checkedIn : (d?.counts.attendees.checkedIn ?? 0);
  const cancelled = d?.counts.attendees.cancelled ?? 0;
  const todo = d?.counts.tasks.TODO ?? 0;
  const inProgress = d?.counts.tasks.IN_PROGRESS ?? 0;
  const done = d?.counts.tasks.DONE ?? 0;
  const taskTotal = todo + inProgress + done;
  const meta = [formatDateRange(event.startDate, event.endDate), d?.profile?.city, d?.profile?.format ? EVENT_FORMAT_LABEL[d.profile.format] : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <aside className={`event-detail${fullPage ? " full-page-detail" : ""}`} aria-live="polite">
      {fullPage && (
        <button className="back-button" type="button" onClick={onBack}>
          <AppIcon name="arrow-left" />
          Etkinliklere Dön
        </button>
      )}
      <div className="detail-status-row">
        <StatusBadge status={EVENT_STATUS_BADGE[event.status]} />
        {live && (
          <span className={`live-update${checkins.connected ? "" : " live-offline"}`}>
            <span aria-hidden="true" />
            {checkins.connected ? "Canlı güncelleniyor" : "Yeniden bağlanıyor"}
          </span>
        )}
      </div>
      <h2>{event.title}</h2>
      <p className="detail-meta">{meta}</p>

      {detail.isError ? (
        <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
      ) : (
        <>
          <section className="detail-block">
            <p className="eyebrow">KATILIM</p>
            <p className="attendance-data">
              <strong>{detail.isPending ? "—" : formatNumber(checkedIn)}</strong>
              <span>/ {formatNumber(total)} giriş</span>
            </p>
            <div
              className="attendance-progress"
              role="progressbar"
              aria-label="Etkinlik katılımı"
              aria-valuenow={Math.round(ratio(checkedIn, total))}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <span style={{ width: `${ratio(checkedIn, total)}%` }} />
            </div>
            <p className="detail-caption">
              {total > 0 ? `${formatPercent(checkedIn, total)} · ` : "Henüz bilet çıkarılmadı · "}
              {formatNumber(cancelled)} bilet iptal edildi
            </p>
          </section>

          <section className="detail-block">
            <p className="eyebrow">GÖREVLER</p>
            <div className="task-bar" role="img" aria-label={`${todo} yapılacak, ${inProgress} sürüyor, ${done} tamamlandı`}>
              {taskTotal === 0 ? (
                <span className="task-empty" style={{ width: "100%" }} />
              ) : (
                <>
                  <span className="task-todo" style={{ width: `${ratio(todo, taskTotal)}%` }} />
                  <span className="task-progress" style={{ width: `${ratio(inProgress, taskTotal)}%` }} />
                  <span className="task-done" style={{ width: `${ratio(done, taskTotal)}%` }} />
                </>
              )}
            </div>
            <div className="task-legend">
              <span><i className="legend-todo" /> Yapılacak {todo}</span>
              <span><i className="legend-progress" /> Sürüyor {inProgress}</span>
              <span><i className="legend-done" /> Tamamlandı {done}</span>
            </div>
          </section>

          <div className="detail-stats">
            <div>
              <span>KPI</span>
              <strong>{d ? d.counts.kpis : "—"}</strong>
            </div>
            <div>
              <span>Anket</span>
              <strong>{d ? d.counts.surveys : "—"}</strong>
            </div>
            <div className={d && d.counts.pendingProposals > 0 ? "pending-stat" : ""}>
              <span>Bekleyen öneri</span>
              <strong>{d ? d.counts.pendingProposals : "—"}</strong>
            </div>
          </div>
        </>
      )}

      <button className="outline-button detail-button" type="button" onClick={() => router.push(`/etkinlikler/${event.id}/genel`)}>
        Etkinliğe Git <span aria-hidden="true">→</span>
      </button>
    </aside>
  );
}
