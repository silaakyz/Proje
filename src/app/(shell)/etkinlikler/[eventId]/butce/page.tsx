"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useBudget, useEventMetrics, useOrg } from "@/lib/api/hooks";
import type { BudgetItem, BudgetKind } from "@/lib/api/types";
import { BUDGET_CATEGORIES, BUDGET_CATEGORY_LABEL, BUDGET_KIND_LABEL, COST_BEHAVIOR_LABEL } from "@/lib/budget/categories";
import { FINANCE_KPI_IDS } from "@/lib/kpi/engine";
import { formatMoney, formatNumber, parseTrNumber } from "@/lib/ui/format";
import { MetricsPanel } from "@/components/eip/kpi";
import { AppIcon, EmptyState, ErrorState, InlineNotice, LoadingMark, Modal, SkeletonRows, useToast } from "@/components/eip/ui";
import { SectionHeading, useEventId } from "@/components/eip/workspace";

const SECTIONS: { kind: BudgetKind; title: string; eyebrow: string; empty: string }[] = [
  { kind: "INCOME", eyebrow: "GELİRLER", title: "Gelir kalemleri", empty: "Gelir kalemi yok. Ücretsiz bir etkinlikte 0 TL'lik bir gelir satırı girin; gelir boş kalırsa toplam gelir hesaplanmaz." },
  { kind: "COST", eyebrow: "GİDERLER", title: "Gider kalemleri", empty: "Gider kalemi yok." },
  { kind: "TICKET_ADJUSTMENT", eyebrow: "BİLET İADE VE İNDİRİMLERİ", title: "İade ve indirimler", empty: "İade veya indirim kaydı yok. Bilet geliri net girildiğinde iade ve indirim oranları için buraya ekleyin." },
];

const triLabel = (b: boolean | null, yes: string, no: string) => (b === null ? "—" : b ? yes : no);
const triValue = (b: boolean | null) => (b === null ? "" : b ? "yes" : "no");
const fromTri = (v: string) => (v === "" ? null : v === "yes");

function ItemModal({ item, kind: initialKind, onClose }: { item: BudgetItem | null; kind: BudgetKind; onClose: () => void }) {
  const eventId = useEventId();
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<BudgetKind>(item?.kind ?? initialKind);
  const [category, setCategory] = useState<string>(item?.category ?? BUDGET_CATEGORIES[initialKind][0]);
  const [label, setLabel] = useState(item?.label ?? "");
  const [planned, setPlanned] = useState(item?.planned != null ? String(item.planned).replace(".", ",") : "");
  const [actual, setActual] = useState(item?.actual != null ? String(item.actual).replace(".", ",") : "");
  const [quantity, setQuantity] = useState(item?.quantity != null ? String(item.quantity) : "");
  const [behavior, setBehavior] = useState<string>(item?.costBehavior ?? "");
  const [supplierLocal, setSupplierLocal] = useState(triValue(item?.supplierLocal ?? null));
  const [funded, setFunded] = useState(triValue(item?.fundedExternally ?? null));
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const isCost = kind === "COST";
  const isTickets = kind === "INCOME" && category === "TICKETS";

  function changeKind(k: BudgetKind) {
    setKind(k);
    setCategory(BUDGET_CATEGORIES[k][0]);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!label.trim()) return setError("Kalem adını girin.");
    const money = (s: string, name: string) => {
      if (!s.trim()) return { ok: true as const, value: null };
      const n = parseTrNumber(s);
      if (n === null || Number.isNaN(n) || n < 0) return { ok: false as const, message: `${name}: 0 veya pozitif bir tutar girin (örn. 12.500,00).` };
      if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return { ok: false as const, message: `${name}: en fazla 2 ondalık basamak.` };
      return { ok: true as const, value: n };
    };
    const p = money(planned, "Planlanan");
    if (!p.ok) return setError(p.message);
    const a = money(actual, "Gerçekleşen");
    if (!a.ok) return setError(a.message);
    if (p.value === null && a.value === null) return setError("Planlanan veya gerçekleşen tutardan en az birini girin.");
    let qty: number | null = null;
    if (isTickets && quantity.trim()) {
      qty = Number(quantity.replace(/\./g, ""));
      if (!Number.isInteger(qty) || qty < 0) return setError("Bilet adedi tam sayı olmalı.");
    }
    const body = {
      organizationId: orgId, kind, category, label: label.trim(), planned: p.value, actual: a.value, quantity: qty,
      costBehavior: isCost && behavior ? behavior : null,
      supplierLocal: isCost ? fromTri(supplierLocal) : null,
      fundedExternally: isCost ? fromTri(funded) : null,
      notes: notes.trim() || null,
    };
    setBusy(true);
    try {
      if (item) await api(`/api/budget-items/${item.id}`, { method: "PATCH", body });
      else await api(`/api/events/${eventId}/budget`, { method: "POST", body });
      toast(item ? "Kalem güncellendi." : "Kalem eklendi.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.budget(eventId) }), qc.invalidateQueries({ queryKey: keys.metrics(eventId) }),
        qc.invalidateQueries({ queryKey: keys.kpis(eventId) })]);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal className="form-modal budget-modal" labelledBy="budget-item-title" onClose={onClose}>
      <p className="eyebrow">{item ? "KALEMİ DÜZENLE" : "YENİ KALEM"}</p>
      <h2 id="budget-item-title">{item ? item.label : "Bütçe kalemi ekle"}</h2>
      <form onSubmit={submit}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <div className="form-modal-row">
          <label>
            <span>Tür</span>
            <select value={kind} onChange={(e) => changeKind(e.target.value as BudgetKind)}>
              {(Object.keys(BUDGET_CATEGORIES) as BudgetKind[]).map((k) => <option value={k} key={k}>{BUDGET_KIND_LABEL[k]}</option>)}
            </select>
          </label>
          <label>
            <span>Kategori</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {BUDGET_CATEGORIES[kind].map((c) => <option value={c} key={c}>{BUDGET_CATEGORY_LABEL[kind][c]}</option>)}
            </select>
          </label>
        </div>
        <label>
          <span>Kalem</span>
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} placeholder="Örn. Ana sahne kirası" />
        </label>
        <div className="form-modal-row">
          <label>
            <span>Planlanan (TL)</span>
            <input inputMode="decimal" value={planned} onChange={(e) => setPlanned(e.target.value)} placeholder="—" />
          </label>
          <label>
            <span>Gerçekleşen (TL)</span>
            <input inputMode="decimal" value={actual} onChange={(e) => setActual(e.target.value)} placeholder="—" />
          </label>
        </div>
        {isTickets && (
          <label>
            <span>Satılan ücretli bilet adedi</span>
            <input inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Ortalama bilet fiyatı için" />
          </label>
        )}
        {isCost && (
          <>
            <label>
              <span>Maliyet davranışı</span>
              <select value={behavior} onChange={(e) => setBehavior(e.target.value)}>
                <option value="">Belirtilmedi</option>
                <option value="FIXED">Sabit (katılımcı sayısından bağımsız)</option>
                <option value="VARIABLE">Değişken (katılımcıyla artar)</option>
              </select>
            </label>
            <div className="form-modal-row">
              <label>
                <span>Tedarikçi bölgede mi?</span>
                <select value={supplierLocal} onChange={(e) => setSupplierLocal(e.target.value)}>
                  <option value="">Belirtilmedi</option>
                  <option value="yes">Evet, yerel</option>
                  <option value="no">Hayır</option>
                </select>
              </label>
              <label>
                <span>Bölge dışı finansmanla mı?</span>
                <select value={funded} onChange={(e) => setFunded(e.target.value)}>
                  <option value="">Belirtilmedi</option>
                  <option value="yes">Evet, dış kaynak</option>
                  <option value="no">Hayır, yerel kaynak</option>
                </select>
              </label>
            </div>
          </>
        )}
        <label>
          <span>Not (isteğe bağlı)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="Fatura no, sözleşme, açıklama" />
        </label>
        <p className="form-modal-note">
          {kind === "TICKET_ADJUSTMENT"
            ? "İade ve indirimler gelir veya gider sayılmaz; bilet geliri net girilir, brüt bilet geliri = net + iade + indirim."
            : isCost
              ? "Başabaş için her gider sabit/değişken; dış finansmanlı yerel harcama için tedarikçi yeri ve finansman kaynağı işaretlenmeli."
              : "Finans metrikleri yalnızca gerçekleşen tutarlardan hesaplanır; planlanan tutar bütçe sapması için kullanılır."}
        </p>
        <div className="form-modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>Vazgeç</button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy && <LoadingMark />}
            {item ? "Kaydet" : "Kalemi Ekle"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function BudgetPage() {
  const eventId = useEventId();
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const budget = useBudget(eventId);
  const metrics = useEventMetrics(eventId);
  const manage = can("budget.manage");
  const [editing, setEditing] = useState<{ item: BudgetItem | null; kind: BudgetKind } | null>(null);
  const [deleting, setDeleting] = useState<BudgetItem | null>(null);
  const [busy, setBusy] = useState(false);
  const financeValues = useMemo(
    () => (metrics.data?.values ?? []).filter((v) => (FINANCE_KPI_IDS as readonly string[]).includes(v.id)),
    [metrics.data],
  );

  if (!can("budget.read")) return <EmptyState title="Bütçe yalnızca kurum sahibi ve yöneticilere açıktır." />;
  if (budget.isPending) return <SkeletonRows rows={5} label="Bütçe yükleniyor" />;
  if (budget.isError) return <ErrorState error={budget.error} onRetry={() => budget.refetch()} />;
  const { items, totals } = budget.data;

  async function remove() {
    if (!deleting) return;
    setBusy(true);
    try {
      await api(`/api/budget-items/${deleting.id}`, { method: "DELETE", query: { organizationId: orgId } });
      toast("Kalem silindi.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.budget(eventId) }), qc.invalidateQueries({ queryKey: keys.metrics(eventId) }),
        qc.invalidateQueries({ queryKey: keys.kpis(eventId) })]);
      setDeleting(null);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const variance = (i: BudgetItem) => (i.planned !== null && i.actual !== null ? i.actual - i.planned : null);

  return (
    <div className="analytics-content budget-page">
      <section className="placeholder-hero">
        <p className="eyebrow">BÜTÇE</p>
        <h2>Gelir, gider ve finans metrikleri</h2>
        <p>
          Planlanan ve gerçekleşen tutarları kalem kalem girin. Finans metrikleri (ROI, katılımcı başı maliyet, başabaş) yalnızca gerçekleşen
          tutarlardan hesaplanır. Bu sayfa ve metrikleri yalnızca kurum sahibi ve yöneticiler görür.
        </p>
      </section>

      <div className="placeholder-preview-grid overview-stats">
        <article>
          <span>Gelir (gerçekleşen)</span>
          <p><strong>{formatMoney(totals.income.actual)}</strong><small>plan {formatMoney(totals.income.planned)}</small></p>
        </article>
        <article>
          <span>Gider (gerçekleşen)</span>
          <p><strong>{formatMoney(totals.cost.actual)}</strong><small>plan {formatMoney(totals.cost.planned)}</small></p>
        </article>
        <article>
          <span>Net sonuç</span>
          <p><strong>{formatMoney(totals.net.actual)}</strong><small>plan {formatMoney(totals.net.planned)}</small></p>
        </article>
      </div>

      <div className="ticket-filters budget-toolbar">
        <span className="muted-text">{formatNumber(items.length)} kalem</span>
        <div className="ticket-filter-actions">
          {items.length > 0 && (
            <a className="outline-button" href={`/api/events/${eventId}/budget/export?organizationId=${orgId}`} download>
              <AppIcon name="download" />
              CSV İndir
            </a>
          )}
          {manage && (
            <button className="primary-button" type="button" onClick={() => setEditing({ item: null, kind: "COST" })}>
              <AppIcon name="plus" />
              Kalem Ekle
            </button>
          )}
        </div>
      </div>

      {SECTIONS.map((s) => {
        const rows = items.filter((i) => i.kind === s.kind);
        return (
          <section className="budget-section" key={s.kind}>
            <SectionHeading eyebrow={s.eyebrow} title={s.title}>
              {manage && (
                <button className="text-button" type="button" onClick={() => setEditing({ item: null, kind: s.kind })}>
                  + Ekle
                </button>
              )}
            </SectionHeading>
            {rows.length === 0 ? (
              <p className="muted-text">{s.empty}</p>
            ) : (
              <div className="tickets-table-wrap">
                <table className="tickets-table budget-table">
                  <thead>
                    <tr>
                      <th>Kalem</th>
                      <th>Kategori</th>
                      <th className="num">Planlanan</th>
                      <th className="num">Gerçekleşen</th>
                      {s.kind !== "TICKET_ADJUSTMENT" && <th className="num">Fark</th>}
                      {s.kind === "COST" && <th>Davranış</th>}
                      {s.kind === "COST" && <th>Yerel / dış</th>}
                      {s.kind === "INCOME" && <th className="num">Bilet adedi</th>}
                      {manage && <th><span className="visually-hidden">İşlemler</span></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => {
                      const d = variance(i);
                      const over = d !== null && (s.kind === "COST" ? d > 0 : d < 0);
                      return (
                        <tr key={i.id}>
                          <td data-label="Kalem"><strong>{i.label}</strong>{i.notes && <small className="budget-note">{i.notes}</small>}</td>
                          <td data-label="Kategori">{BUDGET_CATEGORY_LABEL[i.kind][i.category] ?? i.category}</td>
                          <td data-label="Planlanan" className="num">{formatMoney(i.planned)}</td>
                          <td data-label="Gerçekleşen" className="num">{formatMoney(i.actual)}</td>
                          {s.kind !== "TICKET_ADJUSTMENT" && (
                            <td data-label="Fark" className={`num${over ? " budget-over" : ""}`}>{d === null ? "—" : `${d > 0 ? "+" : d < 0 ? "−" : ""}${formatMoney(Math.abs(d))}`}</td>
                          )}
                          {s.kind === "COST" && <td data-label="Davranış">{i.costBehavior ? COST_BEHAVIOR_LABEL[i.costBehavior] : "—"}</td>}
                          {s.kind === "COST" && (
                            <td data-label="Yerel / dış">
                              {triLabel(i.supplierLocal, "yerel", "bölge dışı")} · {triLabel(i.fundedExternally, "dış finansman", "yerel finansman")}
                            </td>
                          )}
                          {s.kind === "INCOME" && <td data-label="Bilet adedi" className="num">{i.quantity === null ? "—" : formatNumber(i.quantity)}</td>}
                          {manage && (
                            <td className="budget-actions">
                              <button className="text-button" type="button" onClick={() => setEditing({ item: i, kind: i.kind })}>Düzenle</button>
                              <button className="text-button danger" type="button" onClick={() => setDeleting(i)}>Sil</button>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      <section className="analytics-surveys">
        <SectionHeading eyebrow="FİNANS METRİKLERİ" title="Kurum KPI referansına göre" />
        <p className="section-intro">
          Gelen = check-in. Etkinlik ROI finansal ROI&apos;dır (Değer = toplam gelir). Başabaş noktası her gider sabit/değişken olarak
          işaretlendiğinde hesaplanır. Dış finansmanlı yerel harcama, ekonomik etkinin organizatör tarafıdır.
        </p>
        {metrics.isPending ? <SkeletonRows rows={2} label="Metrikler hesaplanıyor" /> : <MetricsPanel values={financeValues} />}
      </section>

      {editing && <ItemModal item={editing.item} kind={editing.kind} onClose={() => setEditing(null)} />}
      {deleting && (
        <Modal className="confirmation-modal" labelledBy="delete-budget-title" onClose={() => setDeleting(null)}>
          <p className="eyebrow">KALEMİ SİL</p>
          <h2 id="delete-budget-title">&ldquo;{deleting.label}&rdquo; silinsin mi?</h2>
          <p>Kalem bütçeden ve finans metriklerinden çıkar. Bu işlem geri alınamaz.</p>
          <div>
            <button className="ghost-button" type="button" onClick={() => setDeleting(null)}>Vazgeç</button>
            <button className="destructive-button" type="button" onClick={remove} disabled={busy}>
              {busy && <LoadingMark />}
              Sil
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
