"use client";
/** Event workspace frame: breadcrumb, title, actions, tabs; plus the edit-event dialog. */
import { useState, type FormEvent, type ReactNode } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { useEventDetail, useOrg, useUpdateEvent } from "@/lib/api/hooks";
import type { EventDetail, EventStatus } from "@/lib/api/types";
import { formatDateRange } from "@/lib/ui/format";
import { EVENT_FORMAT_LABEL, EVENT_STATUS_BADGE, EVENT_STATUS_LABEL } from "@/lib/ui/labels";
import { WORKSPACE_TABS } from "@/components/eip/shell";
import { AppIcon, ErrorState, InlineNotice, LoadingMark, Modal, StatusBadge, useCopy, useToast } from "@/components/eip/ui";

export function useEventId() {
  const params = useParams<{ eventId: string }>();
  return params.eventId;
}

const PAGE_CLASS: Record<string, string> = {
  genel: "overview-workspace",
  oneriler: "suggestions-workspace",
  planlama: "timeline-workspace",
  gorevler: "plan-workspace",
  kpi: "kpi-workspace",
  katilimcilar: "participants-workspace",
  anketler: "surveys-workspace",
  analizler: "analytics-workspace",
  raporlar: "reports-workspace",
  etki: "impact-workspace",
};

function EditEventModal({ event, onClose }: { event: EventDetail; onClose: () => void }) {
  const update = useUpdateEvent(event.id);
  const toast = useToast();
  const [title, setTitle] = useState(event.title);
  const [startDate, setStartDate] = useState(event.startDate ?? "");
  const [endDate, setEndDate] = useState(event.endDate ?? "");
  const [status, setStatus] = useState<EventStatus>(event.status);
  const [error, setError] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!title.trim()) return setError("Etkinlik adını girin.");
    if (endDate && startDate && endDate < startDate) return setError("Bitiş tarihi başlangıçtan önce olamaz.");
    if (status !== "draft" && !startDate) return setError("Canlı veya tamamlanmış bir etkinlik için başlangıç tarihi gerekir.");
    try {
      await update.mutateAsync({
        ...(title.trim() !== event.title ? { title: title.trim() } : {}),
        ...(status !== event.status ? { status } : {}),
        ...((startDate || null) !== event.startDate ? { startDate: startDate || null } : {}),
        ...((endDate || null) !== event.endDate ? { endDate: endDate || null } : {}),
      });
      toast("Etkinlik güncellendi.");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const unchanged = title.trim() === event.title && status === event.status && (startDate || null) === event.startDate && (endDate || null) === event.endDate;

  return (
    <Modal className="form-modal" labelledBy="edit-event-title" onClose={onClose}>
      <p className="eyebrow">ETKİNLİĞİ DÜZENLE</p>
      <h2 id="edit-event-title">Etkinlik bilgileri</h2>
      <form onSubmit={submit}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <label>
          <span>Etkinlik adı</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>
        <div className="form-modal-row">
          <label>
            <span>Başlangıç</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            <span>Bitiş</span>
            <input type="date" value={endDate} min={startDate || undefined} onChange={(e) => setEndDate(e.target.value)} />
          </label>
        </div>
        <label>
          <span>Durum</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as EventStatus)}>
            {(["draft", "live", "completed"] as const).map((s) => (
              <option value={s} key={s}>
                {EVENT_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <p className="form-modal-note">Başlangıç tarihi değişirse, plan takvimini izleyen görevlerin son tarihleri birlikte kayar.</p>
        <div className="form-modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="primary-button" type="submit" disabled={update.isPending || unchanged}>
            {update.isPending && <LoadingMark />}
            Kaydet
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DuplicateEventModal({ event, onClose }: { event: EventDetail; onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId } = useOrg();
  const [title, setTitle] = useState(`${event.title} (kopya)`);
  const [startDate, setStartDate] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!title.trim()) return setError("Yeni etkinliğin adını girin.");
    setBusy(true);
    try {
      const r = await api<{ event: { id: string; copied: { tasks: number; kpis: number; surveys: number } } }>(`/api/events/${event.id}/duplicate`, {
        method: "POST",
        body: { organizationId: orgId, title: title.trim(), startDate: startDate || null },
      });
      await qc.invalidateQueries({ queryKey: ["events"] });
      toast(`Kopya oluşturuldu: ${r.event.copied.tasks} görev, ${r.event.copied.kpis} KPI, ${r.event.copied.surveys} anket.`);
      onClose();
      router.push(`/etkinlikler/${r.event.id}/genel`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal className="form-modal" labelledBy="duplicate-title" onClose={onClose}>
      <p className="eyebrow">ETKİNLİĞİ KOPYALA</p>
      <h2 id="duplicate-title">Yeni etkinlik olarak kopyala</h2>
      <form onSubmit={submit}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <label>
          <span>Yeni etkinliğin adı</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>
        <label>
          <span>Başlangıç tarihi (isteğe bağlı)</span>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <p className="form-modal-note">
          Etkinlik profili, modüller, görev planı, KPI hedefleri ve anket taslakları kopyalanır; görev son tarihleri yeni başlangıç tarihine göre
          hesaplanır. Biletler, girişler, anket yanıtları ve etki hesapları kopyalanmaz. Kopya taslak olarak açılır.
        </p>
        <div className="form-modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy && <LoadingMark />}
            Kopyayı Oluştur
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspaceHeader({ event, activeTab }: { event: EventDetail; activeTab: string }) {
  const router = useRouter();
  const { can } = useOrg();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const { copy } = useCopy();
  const toast = useToast();
  const qc = useQueryClient();
  const { orgId } = useOrg();

  async function setArchived(archived: boolean) {
    try {
      await api(`/api/events/${event.id}/archive`, { method: "POST", body: { organizationId: orgId, archived } });
      await qc.invalidateQueries({ queryKey: ["events"] });
      await qc.invalidateQueries({ queryKey: ["event"] });
      toast(archived ? "Etkinlik arşivlendi; panelde Arşiv sekmesinde görünür." : "Etkinlik arşivden çıkarıldı.");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }
  const meta = [formatDateRange(event.startDate, event.endDate), event.profile?.city, event.profile?.format ? EVENT_FORMAT_LABEL[event.profile.format] : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <header className="workspace-header">
      <p className="workspace-breadcrumb">
        <button type="button" className="breadcrumb-link" onClick={() => router.push("/panel")}>
          Etkinlikler
        </button>
        <span aria-hidden="true">/</span>
        <strong>{event.title}</strong>
      </p>
      {event.archivedAt && (
        <div className="archived-banner" role="status">
          <AppIcon name="archive" />
          <span>Bu etkinlik arşivde. Kayıtları korunur; panelde yalnızca Arşiv sekmesinde listelenir.</span>
          {can("event.write") && (
            <button className="text-button" type="button" onClick={() => setArchived(false)}>
              Arşivden çıkar
            </button>
          )}
        </div>
      )}
      <div className="workspace-heading-row">
        <div>
          <StatusBadge status={EVENT_STATUS_BADGE[event.status]} />
          <h1>{event.title}</h1>
          <p>{meta}</p>
        </div>
        <div className="workspace-actions">
          {can("event.write") && (
            <button className="outline-button" type="button" onClick={() => setEditing(true)}>
              Düzenle
            </button>
          )}
          <div className="more-menu-wrap">
            <button className="more-button" type="button" aria-label="Diğer işlemler" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
              <AppIcon name="more" />
            </button>
            {menuOpen && (
              <div className="more-menu" role="menu" onMouseLeave={() => setMenuOpen(false)}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    router.push(`/etkinlikler/${event.id}/check-in`);
                  }}
                >
                  Kapı moduna geç
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={async () => {
                    setMenuOpen(false);
                    await copy(window.location.href);
                    toast("Bağlantı kopyalandı.");
                  }}
                >
                  Bağlantıyı kopyala
                </button>
                {can("event.write") && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setDuplicating(true);
                      }}
                    >
                      Kopyasını oluştur
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        void setArchived(!event.archivedAt);
                      }}
                    >
                      {event.archivedAt ? "Arşivden çıkar" : "Arşivle"}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <nav className="workspace-tabs" aria-label="Etkinlik çalışma alanı">
        {WORKSPACE_TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => (
          <button
            className={activeTab === tab.path ? "active" : ""}
            type="button"
            key={tab.path}
            aria-current={activeTab === tab.path ? "page" : undefined}
            onClick={() => router.push(`/etkinlikler/${event.id}/${tab.path}`)}
          >
            {tab.label}
            {tab.path === "oneriler" && event.counts.pendingProposals > 0 ? ` (${event.counts.pendingProposals})` : ""}
          </button>
        ))}
      </nav>
      {editing && <EditEventModal event={event} onClose={() => setEditing(false)} />}
      {duplicating && <DuplicateEventModal event={event} onClose={() => setDuplicating(false)} />}
    </header>
  );
}

export function EventWorkspace({ children }: { children: ReactNode }) {
  const eventId = useEventId();
  const pathname = usePathname() ?? "";
  const activeTab = pathname.split("/")[3] ?? "genel";
  const isSurveyDetail = /\/anketler\/[^/]+/.test(pathname);
  const event = useEventDetail(eventId);

  return (
    <main className={`workspace-page ${isSurveyDetail ? "survey-detail-page" : PAGE_CLASS[activeTab] ?? ""}`}>
      {event.isPending ? (
        <div className="workspace-loading" aria-busy="true">
          <span className="skeleton-title" />
          <span className="skeleton-meta" />
        </div>
      ) : event.isError ? (
        <ErrorState error={event.error} title="Etkinlik yüklenemedi." onRetry={() => event.refetch()} />
      ) : (
        <>
          <WorkspaceHeader event={event.data} activeTab={activeTab} />
          {children}
        </>
      )}
    </main>
  );
}

/** Section heading used by the workspace pages (eyebrow + title + optional actions). */
export function SectionHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="section-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h2>{title}</h2>
      </div>
      {children && <div className="section-heading-actions">{children}</div>}
    </div>
  );
}
