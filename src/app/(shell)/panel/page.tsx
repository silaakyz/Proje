"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useArchivedEvents, useDemoInfo, useEvents, useOrg, useTasks } from "@/lib/api/hooks";
import type { EventStatus, EventSummary } from "@/lib/api/types";
import { daysUntil, formatDate, formatDateRange, formatDateTime } from "@/lib/ui/format";
import { EVENT_STATUS_BADGE, EVENT_STATUS_LABEL, PRIORITY_LABEL, ROLE_LABEL } from "@/lib/ui/labels";
import { AppIcon, EmptyState, ErrorState, SkeletonRows, StatusBadge } from "@/components/eip/ui";
import { EventDetailPanel } from "@/components/eip/event-detail-panel";

type Filter = "all" | EventStatus | "archived";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tümü" },
  { key: "live", label: "Canlı" },
  { key: "draft", label: "Taslak" },
  { key: "completed", label: "Tamamlandı" },
  { key: "archived", label: "Arşiv" },
];

function UpcomingTasks({ event }: { event: EventSummary | null }) {
  const router = useRouter();
  const tasks = useTasks(event?.id);
  const upcoming = useMemo(
    () =>
      (tasks.data ?? [])
        .filter((t) => t.status !== "DONE")
        .sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"))
        .slice(0, 4),
    [tasks.data],
  );
  return (
    <section>
      <div className="overview-heading">
        <div>
          <p className="eyebrow">YAKLAŞAN GÖREVLER</p>
          <h2>{event ? event.title : "Görevler"}</h2>
        </div>
        {event && (
          <button type="button" onClick={() => router.push(`/etkinlikler/${event.id}/gorevler`)}>
            Tüm Görevlere Git
          </button>
        )}
      </div>
      {!event ? (
        <p className="overview-empty">Bir etkinlik seçin.</p>
      ) : tasks.isPending ? (
        <SkeletonRows rows={3} />
      ) : tasks.isError ? (
        <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
      ) : upcoming.length === 0 ? (
        <p className="overview-empty">Açık görev yok.</p>
      ) : (
        upcoming.map((t) => {
          const days = t.dueDate ? daysUntil(t.dueDate) : null;
          return (
            <div className="dashboard-task-row" key={t.id}>
              <span>{t.title}</span>
              <time className={days !== null && days < 0 ? "due-overdue" : days !== null && days <= 3 ? "due-soon" : ""}>
                {t.dueDate ? formatDate(t.dueDate, true) : "—"}
              </time>
              <small>{t.priority ? PRIORITY_LABEL[t.priority] : ""}</small>
            </div>
          );
        })
      )}
    </section>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { orgName, role, email, can } = useOrg();
  const demo = useDemoInfo();
  const active = useEvents();
  const [filter, setFilter] = useState<Filter>("all");
  const archived = useArchivedEvents(filter === "archived");
  const events = filter === "archived" ? archived : active;
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const isDemo = !!demo.data?.enabled && !!email && demo.data.email?.toLowerCase() === email.toLowerCase();

  const all = useMemo(() => events.data ?? [], [events.data]);
  const counts = useMemo(
    () => {
      const a = active.data ?? [];
      return { all: a.length, live: a.filter((e) => e.status === "live").length, draft: a.filter((e) => e.status === "draft").length, completed: a.filter((e) => e.status === "completed").length };
    },
    [active.data],
  );
  const filtered = all.filter(
    (e) => (filter === "all" || filter === "archived" || e.status === filter) && e.title.toLocaleLowerCase("tr-TR").includes(search.toLocaleLowerCase("tr-TR")),
  );
  // Default selection: a live event first, otherwise the first one.
  useEffect(() => {
    if (!all.length) return;
    if (!selectedId || !all.some((e) => e.id === selectedId)) setSelectedId((all.find((e) => e.status === "live") ?? all[0])!.id);
  }, [all, selectedId]);
  const selected = all.find((e) => e.id === selectedId) ?? null;
  const recent = [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3);

  if (mobileDetail && selected) {
    return (
      <div className="mobile-detail-page">
        <EventDetailPanel event={selected} fullPage onBack={() => setMobileDetail(false)} />
      </div>
    );
  }

  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">
            {orgName.toLocaleUpperCase("tr-TR")}
            {isDemo ? " · DEMO KURULUŞ" : ""} · {role ? ROLE_LABEL[role] : ""}
          </p>
          <h1>Etkinlikleriniz</h1>
        </div>
        <div className="dashboard-header-actions">
          <button className="outline-button assistant-button" type="button" onClick={() => router.push("/asistan")}>
            Asistana Git
          </button>
          {can("event.write") && (
            <button className="primary-button create-event-button" type="button" onClick={() => router.push("/etkinlikler/yeni")}>
              <AppIcon name="plus" />
              Yeni Etkinlik Oluştur
            </button>
          )}
        </div>
      </header>

      {isDemo && (
        <div className="demo-mode-notice">
          <strong>Demo oturumu</strong>
          <span>Sunum için hazırlanmış örnek kurum verileri gösteriliyor; yaptığınız değişiklikler bu demo kurumuna kaydedilir.</span>
        </div>
      )}

      <div className="dashboard-tools">
        <div className="segment-control" role="tablist" aria-label="Etkinlik durumunu filtrele">
          {FILTERS.map((f) => (
            <button className={filter === f.key ? "active" : ""} type="button" role="tab" aria-selected={filter === f.key} key={f.key} onClick={() => setFilter(f.key)}>
              {f.label}{f.key === "archived" ? "" : ` ${counts[f.key]}`}
            </button>
          ))}
        </div>
        <label className="search-field">
          <span className="visually-hidden">Etkinlik ara</span>
          <AppIcon name="search" />
          <input type="search" placeholder="Etkinlik ara" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
      </div>

      {events.isError && <ErrorState error={events.error} title="Etkinlikler yüklenemedi." onRetry={() => events.refetch()} />}

      <div className="dashboard-body">
        <section className="events-list" aria-label="Etkinlik listesi">
          {events.isPending ? (
            <SkeletonRows label="Etkinlikler yükleniyor" />
          ) : all.length === 0 && filter === "archived" ? (
            <EmptyState title="Arşivde etkinlik yok. Bir etkinliği çalışma alanındaki ⋯ menüsünden arşivleyebilirsiniz." />
          ) : all.length === 0 ? (
            <EmptyState title="Henüz etkinlik yok.">
              {can("event.write") && (
                <button className="outline-button" type="button" onClick={() => router.push("/etkinlikler/yeni")}>
                  İlk Etkinliği Oluştur
                </button>
              )}
            </EmptyState>
          ) : filtered.length === 0 ? (
            <EmptyState title="Aramanızla eşleşen etkinlik yok." />
          ) : (
            filtered.map((e) => (
              <button
                className={`event-row${e.id === selectedId ? " selected" : ""}`}
                type="button"
                key={e.id}
                onClick={() => {
                  setSelectedId(e.id);
                  if (window.matchMedia("(max-width: 1100px)").matches) setMobileDetail(true);
                }}
              >
                <span className="event-main">
                  <span className="event-title-line">
                    <strong>{e.title}</strong>
                    {e.fromBlueprint && <span className="proposal-tag">Plan önerisi</span>}
                  </span>
                  <span className="event-meta">{formatDateRange(e.startDate, e.endDate)}</span>
                </span>
                <StatusBadge status={EVENT_STATUS_BADGE[e.status]} />
              </button>
            ))
          )}
        </section>
        {selected && <EventDetailPanel event={selected} />}
      </div>

      {all.length > 0 && (
        <div className="dashboard-overview-grid">
          <UpcomingTasks event={selected} />
          <section>
            <div className="overview-heading">
              <div>
                <p className="eyebrow">SON ETKİNLİKLER</p>
                <h2>Son hareketler</h2>
              </div>
            </div>
            {recent.map((e) => (
              <div className="recent-event-row" key={e.id}>
                <strong>{e.title}</strong>
                <span>{EVENT_STATUS_LABEL[e.status]} · güncellendi</span>
                <time>{formatDateTime(e.updatedAt, false)}</time>
              </div>
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
