"use client";

import { useRouter } from "next/navigation";
import { useEventDetail, useOrg } from "@/lib/api/hooks";
import { formatNumber, formatPercent } from "@/lib/ui/format";
import { EVENT_FORMAT_LABEL, moduleLabel } from "@/lib/ui/labels";
import { SectionHeading, useEventId } from "@/components/eip/workspace";
import { AppIcon } from "@/components/eip/ui";

export default function EventOverviewPage() {
  const router = useRouter();
  const eventId = useEventId();
  const { can } = useOrg();
  const { data: event } = useEventDetail(eventId);
  if (!event) return null;

  const c = event.counts;
  const tasksTotal = (c.tasks.TODO ?? 0) + (c.tasks.IN_PROGRESS ?? 0) + (c.tasks.DONE ?? 0);
  const p = event.profile;
  const go = (tab: string) => router.push(`/etkinlikler/${eventId}/${tab}`);

  const steps: { done: boolean; text: string; tab: string; action: string }[] = [
    { done: c.pendingProposals === 0, text: c.pendingProposals ? `${c.pendingProposals} plan önerisi kararınızı bekliyor` : "Bekleyen plan önerisi yok", tab: "oneriler", action: "Önerileri İncele" },
    { done: tasksTotal > 0, text: tasksTotal ? `${formatNumber(tasksTotal)} görev planlandı, ${formatNumber(c.tasks.DONE ?? 0)} tamamlandı` : "Görev planı henüz yok", tab: "gorevler", action: "Görevlere Git" },
    { done: c.attendees.total > 0, text: c.attendees.total ? `${formatNumber(c.attendees.total)} geçerli bilet çıkarıldı` : "Henüz bilet çıkarılmadı", tab: "katilimcilar", action: "Biletleri Yönet" },
    { done: c.surveys > 0, text: c.surveys ? `${c.surveys} anket hazır` : "Anket taslağı yok", tab: "anketler", action: "Anketlere Git" },
    { done: event.status !== "draft", text: event.status === "draft" ? "Etkinlik taslak durumunda; kapı açılmadan önce Düzenle'den Canlı yapın" : "Etkinlik yayında", tab: "check-in", action: "Kapı Modu" },
  ];

  return (
    <div className="overview-content">
      <section className="placeholder-hero overview-hero">
        <p className="eyebrow">ETKİNLİK ÇALIŞMA ALANI</p>
        <h2>Operasyonun ortak görünümü</h2>
        <p>Canlı durum, açık işler ve ölçüm hazırlığı aynı yerde. Tüm sayılar kayıtlı verilerden gelir.</p>
      </section>

      <div className="placeholder-preview-grid overview-stats">
        <article>
          <span>Giriş</span>
          <p>
            <strong>{formatNumber(c.attendees.checkedIn)}</strong> / {formatNumber(c.attendees.total)}
            <small>{c.attendees.total ? formatPercent(c.attendees.checkedIn, c.attendees.total) : "bilet yok"}</small>
          </p>
        </article>
        <article>
          <span>Görev</span>
          <p>
            <strong>{formatNumber(c.tasks.DONE ?? 0)}</strong> / {formatNumber(tasksTotal)}
            <small>{formatNumber(c.tasks.IN_PROGRESS ?? 0)} sürüyor</small>
          </p>
        </article>
        <article>
          <span>Ölçüm</span>
          <p>
            <strong>{c.kpis}</strong> KPI · <strong>{c.surveys}</strong> anket
            <small>{c.pendingProposals} bekleyen öneri</small>
          </p>
        </article>
      </div>

      <div className="overview-columns">
        <section>
          <SectionHeading eyebrow="ETKİNLİK PROFİLİ" title="Plan özeti" />
          {p ? (
            <dl className="profile-list">
              <div><dt>Format</dt><dd>{p.format ? EVENT_FORMAT_LABEL[p.format] ?? p.format : "—"}</dd></div>
              <div><dt>Şehir</dt><dd>{p.city ?? "—"}{p.nuts2Code ? ` · ${p.nuts2Code}` : ""}</dd></div>
              <div><dt>Beklenen katılım</dt><dd>{p.expectedAttendance ? formatNumber(p.expectedAttendance) : "Belirtilmedi"}</dd></div>
              <div><dt>Hedef kitle</dt><dd>{p.audience ?? "Belirtilmedi"}</dd></div>
              <div>
                <dt>Hedefler</dt>
                <dd>
                  {p.objectives?.length ? (
                    <ul>{p.objectives.map((o, i) => <li key={i}>{o.text}{o.origin === "INFERRED" ? <em className="inferred-tag"> öneri</em> : null}</li>)}</ul>
                  ) : "—"}
                </dd>
              </div>
              <div>
                <dt>Modüller</dt>
                <dd className="module-chips">
                  {p.modules?.length ? p.modules.map((m) => <span key={m.key}>{moduleLabel(m.key)}</span>) : "—"}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="muted-text">Bu etkinlik plan önerisi olmadan oluşturuldu; profil bilgisi yok.</p>
          )}
        </section>

        <section>
          <SectionHeading eyebrow="SIRADAKİ ADIMLAR" title="Hazırlık durumu" />
          <div className="readiness-list next-steps">
            {steps.map((s) => (
              <div className={s.done ? "ready" : "missing"} key={s.tab}>
                <span className="readiness-icon" aria-hidden="true"><AppIcon name={s.done ? "check" : "close"} /></span>
                <strong>{s.text}</strong>
                <span />
                <b>
                  {(s.tab !== "oneriler" || can("proposal.decide") || c.pendingProposals === 0) && (
                    <button type="button" className="text-link" onClick={() => go(s.tab)}>
                      {s.action}
                    </button>
                  )}
                </b>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
