"use client";

import { useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useKpis, useOrg, useOrgMutation } from "@/lib/api/hooks";
import type { Kpi, KpiActual } from "@/lib/api/types";
import { allowsManualFallback, KPI_BY_ID } from "@/lib/kpi/catalog";
import { formatDecimal, formatKpiValue, parseTrNumber } from "@/lib/ui/format";
import { KPI_SOURCE_LABEL, KPI_STATUS_BADGE, metricInfo } from "@/lib/ui/labels";
import { EmptyState, ErrorState, LoadingMark, SkeletonRows, StatusBadge, useToast } from "@/components/eip/ui";
import { EvidenceBadge } from "@/components/eip/kpi";
import { SectionHeading, useEventId } from "@/components/eip/workspace";

function ManualActual({ kpi, unit, editable }: { kpi: Kpi; unit: string; editable: boolean }) {
  const eventId = useEventId();
  const toast = useToast();
  const initial = kpi.actualValue === null ? "" : formatDecimal(Number(kpi.actualValue)).replace(/\./g, "");
  const [value, setValue] = useState(initial);
  const update = useOrgMutation(
    (organizationId, body: { actualValue: number | null }) => api(`/api/kpis/${kpi.id}`, { method: "PATCH", body: { organizationId, ...body } }),
    () => [keys.kpis(eventId)],
  );
  async function save() {
    const n = parseTrNumber(value);
    if (Number.isNaN(n)) return toast("Gerçekleşen değer sayı olmalı.", "error");
    try {
      await update.mutateAsync({ actualValue: n });
      toast(n === null ? "Gerçekleşen değer kaldırıldı." : "Gerçekleşen değer kaydedildi.");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }
  if (!editable) return kpi.actualValue !== null ? <>{`${formatDecimal(Number(kpi.actualValue))} ${unit}`} <small className="muted-text">elle girildi</small></> : <span className="muted-text">Veri bekleniyor</span>;
  return (
    <span className="kpi-target" title="Bu metrik platformda toplanan veriden hesaplanmıyor; kaynağını bildiğiniz değeri girin.">
      <input inputMode="decimal" value={value} placeholder="elle gir" aria-label={`${kpi.metricName} gerçekleşen`} onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()} />
      <small>{unit}</small>
      {value !== initial && (
        <button type="button" className="text-link" onClick={save} disabled={update.isPending}>
          Kaydet
        </button>
      )}
    </span>
  );
}

function ComputedActual({ actual }: { actual: KpiActual }) {
  const c = actual.computed!;
  const def = KPI_BY_ID.get(c.id);
  if (c.value === null)
    return (
      <span className="muted-text" title={c.note}>
        {c.reason === "zero_denominator" ? "Payda sıfır" : "Henüz veri yok"}
      </span>
    );
  return (
    <span className="observed-value" title={[def?.formula, c.note].filter(Boolean).join(" · ")}>
      {formatKpiValue(c.value, def?.unit ?? "", c.id)}
      <small>{c.n !== undefined ? `n = ${c.n.toLocaleString("tr-TR")} · hesaplandı` : "hesaplandı"}</small>
    </span>
  );
}

function KpiRow({ kpi, actual }: { kpi: Kpi; actual: KpiActual | null }) {
  const eventId = useEventId();
  const toast = useToast();
  const { can } = useOrg();
  const info = metricInfo(kpi.metricName);
  const initial = kpi.targetValue === null ? "" : formatDecimal(Number(kpi.targetValue)).replace(/\./g, "");
  const [target, setTarget] = useState(initial);
  const update = useOrgMutation(
    (organizationId, body: { status?: "ACTIVE" | "DROPPED"; targetValue?: number | null }) =>
      api(`/api/kpis/${kpi.id}`, { method: "PATCH", body: { organizationId, ...body } }),
    () => [keys.kpis(eventId), ["event"]],
  );
  const editable = can("event.write");

  async function run(body: { status?: "ACTIVE" | "DROPPED"; targetValue?: number | null }, done: string) {
    try {
      await update.mutateAsync(body);
      toast(done);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  function saveTarget() {
    const n = parseTrNumber(target);
    if (Number.isNaN(n)) return toast("Hedef değeri sayı olmalı (örn. 4.800 veya 65,5).", "error");
    void run({ targetValue: n }, n === null ? "Hedef kaldırıldı." : "Hedef kaydedildi.");
  }

  return (
    <tr>
      <td data-label="Metrik">
        <strong>{info.name}</strong>
        {actual?.catalogId && KPI_BY_ID.get(actual.catalogId) && <EvidenceBadge def={KPI_BY_ID.get(actual.catalogId)!} />}
        <small className="kpi-description">{kpi.rationale ?? info.description}</small>
      </td>
      <td data-label="Kaynak">{kpi.dataSource ? KPI_SOURCE_LABEL[kpi.dataSource] ?? kpi.dataSource : "—"}</td>
      <td data-label="Durum">
        <StatusBadge status={KPI_STATUS_BADGE[kpi.status] ?? kpi.status} />
      </td>
      <td data-label="Hedef">
        {editable && kpi.status !== "DROPPED" ? (
          <span className="kpi-target">
            <input
              inputMode="decimal"
              value={target}
              placeholder="—"
              aria-label={`${info.name} hedefi`}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveTarget()}
            />
            <small>{info.unit}</small>
            {target !== initial && (
              <button type="button" className="text-link" onClick={saveTarget} disabled={update.isPending}>
                Kaydet
              </button>
            )}
          </span>
        ) : kpi.targetValue !== null ? (
          `${formatDecimal(Number(kpi.targetValue))} ${info.unit}`
        ) : (
          "—"
        )}
      </td>
      <td data-label="Gerçekleşen">
        {actual?.computed && (actual.computed.value !== null || !allowsManualFallback(actual.computed.id))
          ? <ComputedActual actual={actual} />
          : <ManualActual kpi={kpi} unit={info.unit} editable={editable && kpi.status !== "DROPPED"} />}
      </td>
      <td className="kpi-actions">
        {editable && kpi.status === "PROPOSED" && (
          <>
            <button className="outline-button" type="button" disabled={update.isPending} onClick={() => run({ status: "ACTIVE" }, "KPI aktifleştirildi.")}>
              {update.isPending && <LoadingMark />}
              Aktifleştir
            </button>
            <button className="ghost-button" type="button" disabled={update.isPending} onClick={() => run({ status: "DROPPED" }, "KPI bırakıldı.")}>
              Bırak
            </button>
          </>
        )}
        {editable && kpi.status === "ACTIVE" && (
          <button className="ghost-button" type="button" disabled={update.isPending} onClick={() => run({ status: "DROPPED" }, "KPI bırakıldı.")}>
            Bırak
          </button>
        )}
        {editable && kpi.status === "DROPPED" && (
          <button className="ghost-button" type="button" disabled={update.isPending} onClick={() => run({ status: "ACTIVE" }, "KPI yeniden aktifleştirildi.")}>
            Yeniden Aktifleştir
          </button>
        )}
      </td>
    </tr>
  );
}

export default function KpiPage() {
  const eventId = useEventId();
  const kpis = useKpis(eventId);
  const list = kpis.data?.kpis ?? [];
  const actuals = new Map((kpis.data?.actuals ?? []).map((a) => [a.id, a]));
  const order = { ACTIVE: 0, PROPOSED: 1, DROPPED: 2 } as const;

  return (
    <section className="kpi-content">
      <SectionHeading eyebrow="KPI VE ÖLÇÜM" title="Başarı ölçütleri">
        <span className="muted-text">
          {list.filter((k) => k.status === "ACTIVE").length} aktif · {list.filter((k) => k.status === "PROPOSED").length} öneri
        </span>
      </SectionHeading>
      <p className="section-intro">
        Gerçekleşen değerler kurumunuzun KPI ve formül referansıyla, kayıtlı bilet, check-in, görev ve anket verisinden anlık hesaplanır.
        Platformun toplamadığı veriye dayanan metrikler için kaynağını bildiğiniz değeri elle girebilirsiniz. Aktifleştirilen veya bırakılan
        KPI'lar yeni plan önerileriyle değiştirilmez.
      </p>
      {kpis.isPending ? (
        <SkeletonRows rows={4} label="KPI'lar yükleniyor" />
      ) : kpis.isError ? (
        <ErrorState error={kpis.error} onRetry={() => kpis.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState title="Henüz KPI yok. Plan önerilerinden KPI kartını uygulayın." />
      ) : (
        <div className="tickets-table-wrap">
          <table className="tickets-table kpi-table">
            <thead>
              <tr>
                <th>Metrik</th>
                <th>Kaynak</th>
                <th>Durum</th>
                <th>Hedef</th>
                <th>Gerçekleşen</th>
                <th><span className="visually-hidden">İşlemler</span></th>
              </tr>
            </thead>
            <tbody>
              {[...list].sort((x, y) => order[x.status] - order[y.status]).map((k) => (
                <KpiRow kpi={k} key={k.id} actual={actuals.get(k.id) ?? null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
