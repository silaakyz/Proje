"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, buildUrl, errorMessage } from "@/lib/api/client";
import { keys, useAttendees, useEventDetail, useOrg } from "@/lib/api/hooks";
import type { Attendee, Ticket } from "@/lib/api/types";
import { formatDateTime, formatNumber, ticketCode } from "@/lib/ui/format";
import { AppIcon, EmptyState, ErrorState, LoadingMark, Modal, SkeletonRows, StatusBadge, useToast } from "@/components/eip/ui";
import { useEventId } from "@/components/eip/workspace";

const DEFAULT_TYPES = ["Genel", "Öğrenci", "Davetli", "Basın"];
const PAGE = 100;

const statusOf = (a: Attendee) => (a.cancelledAt ? "İPTAL" : a.isCheckedIn ? "GİRİŞ YAPTI" : "BEKLİYOR");

function QrModal({ attendee, onClose }: { attendee: Attendee; onClose: () => void }) {
  const eventId = useEventId();
  const { orgId } = useOrg();
  const src = buildUrl(`/api/events/${eventId}/tickets`, { organizationId: orgId, attendeeId: attendee.id, format: "svg" });
  return (
    <Modal className="form-modal qr-modal" labelledBy="qr-title" onClose={onClose}>
      <p className="eyebrow">BİLET QR KODU</p>
      <h2 id="qr-title">{ticketCode(attendee.id)}</h2>
      <p className="muted-text">{attendee.ticketType} bileti · kapıda bu kod okutulur.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="qr-large" src={src} alt={`${ticketCode(attendee.id)} QR kodu`} width={240} height={240} />
      <div className="form-modal-actions">
        <button className="ghost-button" type="button" onClick={onClose}>
          Kapat
        </button>
      </div>
    </Modal>
  );
}

function PrintPreview({ attendeeIds, eventTitle, onClose }: { attendeeIds: string[]; eventTitle: string; onClose: () => void }) {
  const eventId = useEventId();
  const { orgId } = useOrg();
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api<{ tickets: Ticket[] }>(`/api/events/${eventId}/tickets`, { query: { organizationId: orgId, attendeeId: attendeeIds }, signal: ctrl.signal })
      .then((r) => setTickets(r.tickets))
      .catch((e) => (e as Error)?.name !== "AbortError" && setError(e));
    return () => ctrl.abort();
  }, [eventId, orgId, attendeeIds]);
  return (
    <div className="print-overlay" role="dialog" aria-modal="true" aria-label="Baskı önizlemesi">
      <div className="print-toolbar">
        <div>
          <p className="eyebrow">BASKI ÖNİZLEMESİ</p>
          <span>{tickets ? `${tickets.length} bilet · A4` : "Biletler hazırlanıyor"}</span>
        </div>
        <div className="print-toolbar-actions">
          <button className="primary-button" type="button" onClick={() => window.print()} disabled={!tickets?.length}>
            <AppIcon name="printer" />
            Yazdır
          </button>
          <button className="outline-button" type="button" onClick={onClose}>
            Önizlemeyi Kapat
          </button>
        </div>
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : !tickets ? (
        <SkeletonRows rows={3} />
      ) : tickets.length === 0 ? (
        <EmptyState title="Yazdırılacak geçerli bilet yok (iptal edilen biletler basılmaz)." />
      ) : (
        <div className="a4-sheet">
          {tickets.map((t) => (
            <article className="print-ticket" key={t.attendeeId}>
              <p>{eventTitle}</p>
              <span>{t.ticketType}</span>
              <div className="ticket-qr" dangerouslySetInnerHTML={{ __html: t.qrSvg }} />
              <strong>{ticketCode(t.attendeeId)}</strong>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ParticipantsPage() {
  const eventId = useEventId();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const event = useEventDetail(eventId);
  const canRead = can("attendee.read");
  const canWrite = can("attendee.write");
  const attendees = useAttendees(eventId, canRead);
  const [ticketType, setTicketType] = useState("Genel");
  const [quantity, setQuantity] = useState("10");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [overlay, setOverlay] = useState<"cancel" | "print" | null>(null);
  const [qrFor, setQrFor] = useState<Attendee | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [cancelIds, setCancelIds] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [filter, setFilter] = useState<"all" | "in" | "waiting" | "cancelled">("all");
  const [limit, setLimit] = useState(PAGE);

  const all = useMemo(() => [...(attendees.data ?? [])].reverse(), [attendees.data]);
  const valid = all.filter((a) => !a.cancelledAt);
  const types = useMemo(() => [...new Set([...DEFAULT_TYPES, ...all.map((a) => a.ticketType)])], [all]);
  const filtered = all.filter((a) =>
    filter === "all" ? true : filter === "in" ? a.isCheckedIn && !a.cancelledAt : filter === "waiting" ? !a.isCheckedIn && !a.cancelledAt : !!a.cancelledAt,
  );
  const shown = filtered.slice(0, limit);
  const printIds = useMemo(() => [...selected].slice(0, 500), [selected]);
  const allShownSelected = shown.length > 0 && shown.every((a) => selected.has(a.id));

  async function refresh() {
    await Promise.all([qc.invalidateQueries({ queryKey: keys.attendees(eventId) }), qc.invalidateQueries({ queryKey: ["event"] }), qc.invalidateQueries({ queryKey: keys.checkins(eventId) })]);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    const n = Number(quantity);
    if (!Number.isInteger(n) || n < 1 || n > 500) return toast("Adet 1 ile 500 arasında olmalı.", "error");
    setCreating(true);
    try {
      await api(`/api/events/${eventId}/attendees`, { method: "POST", body: { organizationId: orgId, ticketType, quantity: n } });
      toast(`${formatNumber(n)} ${ticketType} bileti oluşturuldu.`);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setCreating(false);
    }
  }

  async function cancelTickets() {
    setCancelling(true);
    try {
      const r = await api<{ cancelled: string[]; alreadyCancelled: string[]; checkedIn: string[]; notFound: string[] }>(
        `/api/events/${eventId}/attendees/cancel`,
        { method: "POST", body: { organizationId: orgId, attendeeIds: cancelIds } },
      );
      const parts = [`${r.cancelled.length} bilet iptal edildi`];
      if (r.checkedIn.length) parts.push(`${r.checkedIn.length} giriş yapmış bilet iptal edilmedi`);
      if (r.alreadyCancelled.length) parts.push(`${r.alreadyCancelled.length} bilet zaten iptaldi`);
      toast(`${parts.join(", ")}.`);
      setSelected(new Set());
      setOverlay(null);
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setCancelling(false);
    }
  }

  if (!canRead) {
    return (
      <section className="participants-locked">
        <EmptyState title="Bilet listesi yalnızca kurum sahibi ve yöneticilere açıktır. Kapıda giriş için Check-in modunu kullanın.">
          <button className="primary-button" type="button" onClick={() => router.push(`/etkinlikler/${eventId}/check-in`)}>
            Check-in Moduna Geç
          </button>
        </EmptyState>
      </section>
    );
  }

  return (
    <>
      {canWrite && (
        <section className="ticket-create-block">
          <p className="eyebrow">BİLET ÇIKAR</p>
          <form className="ticket-create-form" onSubmit={create}>
            <label>
              <span>Bilet türü</span>
              <select value={ticketType} onChange={(e) => setTicketType(e.target.value)}>
                {types.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Adet</span>
              <input type="number" min="1" max="500" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </label>
            <button className="primary-button" type="submit" disabled={creating}>
              {creating && <LoadingMark />}
              Bilet Oluştur
            </button>
          </form>
        </section>
      )}

      <div className="ticket-summary">
        <div>
          <span>Toplam</span>
          <strong>{formatNumber(valid.length)}</strong>
        </div>
        <div>
          <span>Giriş yapan</span>
          <strong>{formatNumber(valid.filter((a) => a.isCheckedIn).length)}</strong>
        </div>
        <div>
          <span>İptal</span>
          <strong>{formatNumber(all.length - valid.length)}</strong>
        </div>
      </div>

      <div className="ticket-filters">
        <div className="segment-control" role="tablist" aria-label="Biletleri filtrele">
          {([["all", "Tümü"], ["in", "Giriş yapan"], ["waiting", "Bekleyen"], ["cancelled", "İptal"]] as const).map(([k, l]) => (
            <button className={filter === k ? "active" : ""} type="button" role="tab" aria-selected={filter === k} key={k} onClick={() => { setFilter(k); setLimit(PAGE); }}>
              {l}
            </button>
          ))}
        </div>
        <div className="ticket-filter-actions">
          {canRead && (
            <a className="outline-button" href={`/api/events/${eventId}/attendees/export?organizationId=${orgId}`} download>
              <AppIcon name="download" />
              CSV İndir
            </a>
          )}
          <button className="outline-button" type="button" onClick={() => router.push(`/etkinlikler/${eventId}/check-in`)}>
            <AppIcon name="qr" />
            Check-in Moduna Geç
          </button>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="selection-bar">
          <span>{formatNumber(selected.size)} bilet seçildi</span>
          <div>
            <button className="outline-button" type="button" onClick={() => setOverlay("print")}>
              Yazdırılabilir Biletler
            </button>
            {canWrite && (
              <button
                className="destructive-outline-button"
                type="button"
                onClick={() => {
                  setCancelIds([...selected]);
                  setOverlay("cancel");
                }}
              >
                Biletleri İptal Et
              </button>
            )}
          </div>
        </div>
      )}

      {attendees.isPending ? (
        <SkeletonRows rows={5} label="Biletler yükleniyor" />
      ) : attendees.isError ? (
        <ErrorState error={attendees.error} onRetry={() => attendees.refetch()} />
      ) : all.length === 0 ? (
        <EmptyState title="Henüz bilet yok. Yukarıdan bilet türü ve adet seçerek oluşturun." />
      ) : (
        <div className="tickets-table-wrap">
          <table className="tickets-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Görünen biletleri seç"
                    checked={allShownSelected}
                    onChange={(e) =>
                      setSelected((cur) => {
                        const next = new Set(cur);
                        shown.forEach((a) => (e.target.checked ? next.add(a.id) : next.delete(a.id)));
                        return next;
                      })
                    }
                  />
                </th>
                <th>Bilet No</th>
                <th>Tür</th>
                <th>Oluşturma</th>
                <th>Giriş</th>
                <th>Durum</th>
                <th><span className="visually-hidden">İşlemler</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${ticketCode(a.id)} biletini seç`}
                      checked={selected.has(a.id)}
                      onChange={(e) =>
                        setSelected((cur) => {
                          const next = new Set(cur);
                          if (e.target.checked) next.add(a.id);
                          else next.delete(a.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td data-label="Bilet No"><strong>{ticketCode(a.id)}</strong></td>
                  <td data-label="Tür">{a.ticketType}</td>
                  <td data-label="Oluşturma">{formatDateTime(a.createdAt)}</td>
                  <td data-label="Giriş">{a.checkedInAt ? formatDateTime(a.checkedInAt, false) : "—"}</td>
                  <td data-label="Durum"><StatusBadge status={statusOf(a)} /></td>
                  <td className="ticket-actions">
                    <button type="button" aria-label={`${ticketCode(a.id)} bilet işlemleri`} aria-expanded={openMenu === a.id} onClick={() => setOpenMenu((c) => (c === a.id ? null : a.id))}>
                      <AppIcon name="more" />
                    </button>
                    {openMenu === a.id && (
                      <div className="ticket-row-menu" role="menu" onMouseLeave={() => setOpenMenu(null)}>
                        {canWrite && !a.cancelledAt && (
                          <button type="button" role="menuitem" onClick={() => { setOpenMenu(null); setQrFor(a); }}>
                            QR Göster
                          </button>
                        )}
                        {canWrite && !a.cancelledAt && !a.isCheckedIn && (
                          <button className="destructive" type="button" role="menuitem" onClick={() => { setOpenMenu(null); setCancelIds([a.id]); setOverlay("cancel"); }}>
                            İptal Et
                          </button>
                        )}
                        {(a.cancelledAt || a.isCheckedIn) && <span className="menu-note">{a.cancelledAt ? "İptal edilmiş bilet" : "Giriş yapmış bilet iptal edilemez"}</span>}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length > shown.length && (
            <button className="text-link show-more" type="button" onClick={() => setLimit((l) => l + PAGE)}>
              {formatNumber(filtered.length - shown.length)} bilet daha göster
            </button>
          )}
        </div>
      )}

      {overlay === "cancel" && (
        <Modal className="confirmation-modal" labelledBy="cancel-tickets-title" onClose={() => setOverlay(null)}>
          <p className="eyebrow">BİLETLERİ İPTAL ET</p>
          <h2 id="cancel-tickets-title">{formatNumber(cancelIds.length)} bilet iptal edilsin mi?</h2>
          <p>Giriş yapmış biletler iptal edilemez. İptal edilen biletler tüm sayımlardan çıkar ve kapıda kabul edilmez.</p>
          <div>
            <button className="ghost-button" type="button" onClick={() => setOverlay(null)}>
              Vazgeç
            </button>
            <button className="destructive-button" type="button" onClick={cancelTickets} disabled={cancelling}>
              {cancelling && <LoadingMark />}
              {formatNumber(cancelIds.length)} Bileti İptal Et
            </button>
          </div>
        </Modal>
      )}
      {overlay === "print" && (
        <PrintPreview attendeeIds={printIds} eventTitle={event.data?.title ?? ""} onClose={() => setOverlay(null)} />
      )}
      {qrFor && <QrModal attendee={qrFor} onClose={() => setQrFor(null)} />}
    </>
  );
}
