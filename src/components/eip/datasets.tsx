"use client";

/**
 * "Kendi verileriniz" on the analytics page: upload an Excel / CSV table, review what each column means (rules and,
 * when configured, a model's suggestion from column statistics), confirm, then see the summary, the metrics it feeds
 * and a written interpretation. Only confirmed tables count in metrics and reports.
 */
import { useMemo, useState, type ChangeEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useDatasets, useEventMetrics, useOrg } from "@/lib/api/hooks";
import type { DatasetColumn, DatasetInfo, DatasetRole, DatasetUploadResult } from "@/lib/api/types";
import { MEASURES } from "@/lib/datasets/measures";
import { KPI_BY_ID } from "@/lib/kpi/catalog";
import { DATASET_KPI_IDS } from "@/lib/kpi/datasets";
import { formatDateTime, formatDecimal, formatKpiValue, formatNumber } from "@/lib/ui/format";
import { AppIcon, InlineNotice, LoadingMark, SkeletonRows, useToast } from "@/components/eip/ui";
import { SectionHeading } from "@/components/eip/workspace";

const MAX_BYTES = 6 * 1024 * 1024;
const ROLE_LABEL: Record<string, string> = { date: "Tarih", group: "Grup etiketi", value: "Diğer sayı (özetlenir)", ignore: "Kullanma" };
const roleLabel = (r: DatasetRole) => (r.startsWith("measure:") ? MEASURES.find((m) => m.key === r.slice(8))?.label ?? r : ROLE_LABEL[r] ?? r);
const TYPE_LABEL: Record<DatasetColumn["type"], string> = { number: "sayı", date: "tarih", boolean: "evet/hayır", text: "metin" };
// totals keep their decimals (1.999,5 is not 2.000); only large values are rounded to whole numbers
const fmt = (n: number) => (Math.abs(n) >= 10_000 ? formatNumber(Math.round(n)) : formatDecimal(Math.round(n * 100) / 100));

function columnHint(c: DatasetColumn) {
  if (c.type === "number" && c.stats.min !== undefined) return `${fmt(c.stats.min)} – ${fmt(c.stats.max!)}, ort. ${fmt(c.stats.mean!)}`;
  if (c.type === "date" && c.stats.first) return `${c.stats.first} – ${c.stats.last}`;
  if (c.stats.top?.length) return c.stats.top.slice(0, 3).map((t) => t.value).join(", ");
  return `${formatNumber(c.distinct)} farklı değer`;
}

function roleOptions(c: DatasetColumn): DatasetRole[] {
  const base: DatasetRole[] = c.type === "date" ? ["date", "ignore"] : c.type === "number" ? ["value", "ignore"] : c.type === "text" ? ["group", "ignore"] : ["ignore"];
  const measures = MEASURES.filter((m) => m.type === c.type).map((m) => `measure:${m.key}` as DatasetRole);
  return [...base, ...measures];
}

/** A small line chart (SVG) for up to three series over dates. */
function LineChart({ series, keysShown, labels }: { series: DatasetInfo["summary"]["series"]; keysShown: string[]; labels: Record<string, string> }) {
  const W = 640, H = 180, P = { l: 48, r: 12, t: 12, b: 24 };
  const values = series.flatMap((s) => keysShown.map((k) => s.values[k]).filter((v): v is number => v !== undefined));
  if (series.length < 2 || !values.length) return null;
  const max = Math.max(...values), min = Math.min(0, ...values);
  const x = (i: number) => P.l + (i / (series.length - 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - min) / (max - min || 1)) * (H - P.t - P.b);
  const colors = ["var(--ink)", "var(--sienna)", "var(--slate)"];
  return (
    <figure className="dataset-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Tarihe göre: ${keysShown.map((k) => labels[k]).join(", ")}`}>
        <line x1={P.l} x2={W - P.r} y1={y(min)} y2={y(min)} className="axis" />
        <text x={P.l - 6} y={y(max) + 4} textAnchor="end">{fmt(max)}</text>
        <text x={P.l - 6} y={y(min) + 4} textAnchor="end">{fmt(min)}</text>
        <text x={P.l} y={H - 6}>{series[0]!.date}</text>
        <text x={W - P.r} y={H - 6} textAnchor="end">{series.at(-1)!.date}</text>
        {keysShown.map((k, ki) => (
          <polyline key={k} fill="none" stroke={colors[ki]} strokeWidth={2} vectorEffect="non-scaling-stroke"
            points={series.map((s, i) => (s.values[k] === undefined ? null : `${x(i)},${y(s.values[k]!)}`)).filter(Boolean).join(" ")} />
        ))}
      </svg>
      <figcaption>{keysShown.map((k, ki) => <span key={k}><i style={{ background: colors[ki] }} />{labels[k]}</span>)}</figcaption>
    </figure>
  );
}

function MappingEditor({ ds, onDone }: { ds: DatasetInfo; onDone: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(ds.name);
  const [roles, setRoles] = useState<Record<string, DatasetRole>>(() => Object.fromEntries(ds.mapping.map((m) => [m.key, m.role])));
  const [preview, setPreview] = useState<{ columns: DatasetColumn[]; rows: (string | number | boolean | null)[][] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const usedMeasures = Object.values(roles).filter((r) => r.startsWith("measure:"));

  async function confirm() {
    setError("");
    const dup = usedMeasures.find((r, i) => usedMeasures.indexOf(r) !== i);
    if (dup) return setError(`"${roleLabel(dup)}" birden fazla sütuna atanmış.`);
    setBusy(true);
    try {
      await api(`/api/datasets/${ds.id}`, { method: "PATCH", body: { organizationId: orgId, name: name.trim() || ds.name, mapping: Object.entries(roles).map(([key, role]) => ({ key, role })) } });
      toast("Eşleştirme onaylandı; metrikler güncellendi.");
      await Promise.all([qc.invalidateQueries({ queryKey: ["datasets"] }), qc.invalidateQueries({ queryKey: ["metrics"] }), qc.invalidateQueries({ queryKey: ["kpis"] })]);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function loadPreview() {
    try {
      setPreview(await api(`/api/datasets/${ds.id}`, { query: { organizationId: orgId } }));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }

  return (
    <div className="dataset-mapping">
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <label className="dataset-name">
        <span>Tablo adı</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
      </label>
      <div className="tickets-table-wrap">
        <table className="tickets-table dataset-mapping-table">
          <thead>
            <tr><th>Sütun</th><th>Tür</th><th>İçerik</th><th>Anlamı</th></tr>
          </thead>
          <tbody>
            {ds.columns.map((c) => {
              const m = ds.mapping.find((x) => x.key === c.key);
              return (
                <tr key={c.key}>
                  <td data-label="Sütun"><strong>{c.header}</strong></td>
                  <td data-label="Tür">{TYPE_LABEL[c.type]}</td>
                  <td data-label="İçerik" className="muted-text">{columnHint(c)}</td>
                  <td data-label="Anlamı">
                    <select aria-label={`${c.header} sütununun anlamı`} value={roles[c.key] ?? "ignore"} onChange={(e) => setRoles((r) => ({ ...r, [c.key]: e.target.value as DatasetRole }))}>
                      {roleOptions(c).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                    </select>
                    {m?.source === "ai" && roles[c.key] === m.role && <small className="dataset-ai-note" title={m.note}>Yapay zekâ önerisi{m.note ? `: ${m.note}` : ""}</small>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {preview ? (
        <div className="tickets-table-wrap dataset-preview">
          <table className="tickets-table">
            <thead><tr>{preview.columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr></thead>
            <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v === null ? "" : typeof v === "boolean" ? (v ? "evet" : "hayır") : typeof v === "number" ? formatDecimal(v) : String(v)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <button className="text-button" type="button" onClick={loadPreview}>İlk satırları göster</button>
      )}
      <div className="data-source-actions">
        <button className="primary-button" type="button" onClick={confirm} disabled={busy}>{busy && <LoadingMark />}Eşleştirmeyi Onayla</button>
        {ds.status === "CONFIRMED" && <button className="ghost-button" type="button" onClick={onDone}>Vazgeç</button>}
      </div>
    </div>
  );
}

function DatasetCard({ ds, aiAvailable, manage, metricsFed }: { ds: DatasetInfo; aiAvailable: boolean; manage: boolean; metricsFed: { id: string; value: number | null; note?: string }[] }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(ds.status === "NEEDS_REVIEW");
  const [busy, setBusy] = useState<"" | "interpret" | "delete">("");
  const s = ds.summary;
  const labels = Object.fromEntries(s.numbers.map((n) => [n.key, n.label]));

  async function interpret() {
    setBusy("interpret");
    try {
      await api(`/api/datasets/${ds.id}/interpret`, { method: "POST", body: { organizationId: orgId } });
      await qc.invalidateQueries({ queryKey: ["datasets"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy("");
    }
  }
  async function remove() {
    setBusy("delete");
    try {
      await api(`/api/datasets/${ds.id}`, { method: "DELETE", query: { organizationId: orgId } });
      toast("Tablo silindi.");
      await Promise.all([qc.invalidateQueries({ queryKey: ["datasets"] }), qc.invalidateQueries({ queryKey: ["metrics"] }), qc.invalidateQueries({ queryKey: ["kpis"] })]);
    } catch (e) {
      toast(errorMessage(e), "error");
      setBusy("");
    }
  }

  return (
    <article className="dataset-card">
      <header>
        <div>
          <h3>{ds.name}</h3>
          <p className="muted-text">{ds.fileName}{ds.sheetName && ds.sheetName !== "CSV" ? ` · ${ds.sheetName}` : ""} · {formatNumber(ds.rowCount)} satır{s.period ? ` · ${s.period.first} – ${s.period.last}` : ""}</p>
        </div>
        <span className={`dataset-status ${ds.status === "CONFIRMED" ? "ok" : "pending"}`}>{ds.status === "CONFIRMED" ? "Onaylandı" : "Eşleştirme onayı bekliyor"}</span>
      </header>
      {ds.droppedColumns.length > 0 && (
        <InlineNotice tone="warning">Kişisel veri olabileceği için alınmayan sütunlar: {ds.droppedColumns.map((d) => d.header).join(", ")}</InlineNotice>
      )}

      {editing && manage ? (
        <MappingEditor ds={ds} onDone={() => setEditing(false)} />
      ) : ds.status === "CONFIRMED" ? (
        <>
          {s.numbers.length > 0 && (
            <div className="tickets-table-wrap">
              <table className="tickets-table dataset-summary-table">
                <thead><tr><th>Değer</th><th className="num">Toplam</th><th className="num">Ortalama</th><th className="num">En az</th><th className="num">En çok</th><th className="num">n</th></tr></thead>
                <tbody>
                  {s.numbers.map((n) => (
                    <tr key={n.key}>
                      <td data-label="Değer"><strong>{n.label}</strong>{n.label !== n.header && <small className="budget-note">{n.header}</small>}</td>
                      <td data-label="Toplam" className="num">{fmt(n.sum)}{n.unit && ` ${n.unit}`}</td>
                      <td data-label="Ortalama" className="num">{fmt(n.mean)}</td>
                      <td data-label="En az" className="num">{fmt(n.min)}</td>
                      <td data-label="En çok" className="num">{fmt(n.max)}</td>
                      <td data-label="n" className="num">{formatNumber(n.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.booleans.map((b) => <p key={b.key} className="dataset-line"><strong>{b.label}:</strong> %{formatDecimal(Math.round(b.trueShare * 10) / 10)} evet (n = {formatNumber(b.n)})</p>)}
          {s.series.length > 1 && <LineChart series={s.series} keysShown={s.seriesKeys} labels={labels} />}
          {s.breakdown && (
            <div className="dataset-breakdown">
              <p className="eyebrow">{s.breakdown.group.toLocaleUpperCase("tr-TR")} · {s.breakdown.by}</p>
              <div className="spend-bars analytics-bars">
                {s.breakdown.items.map((i) => {
                  const max = Math.max(1, ...s.breakdown!.items.map((x) => x.value));
                  return (
                    <div className="spend-bar-row" key={i.label}>
                      <span title={i.label}>{i.label}</span>
                      <i><i style={{ width: `${(Math.max(0, i.value) / max) * 100}%` }} /></i>
                      <strong>{fmt(i.value)}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {metricsFed.length > 0 && (
            <div className="dataset-metrics">
              <p className="eyebrow">BESLEDİĞİ METRİKLER</p>
              <ul>
                {metricsFed.map((m) => {
                  const def = KPI_BY_ID.get(m.id);
                  return (
                    <li key={m.id} title={def?.formula}>
                      <span>{def?.name ?? m.id}</span>
                      <strong>{m.value === null ? "hesaplanamadı" : formatKpiValue(m.value, def?.unit ?? "", m.id)}</strong>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <div className="dataset-interpretation">
            <p className="eyebrow">YORUM</p>
            {ds.interpretation ? (
              <>
                {ds.interpretation.stale && <InlineNotice tone="warning">Tablo veya eşleştirme yorumdan sonra değişti; yeniden yorumlatın.</InlineNotice>}
                <div className="dataset-interpretation-text">{ds.interpretation.text}</div>
                <small className="muted-text">Yapay zekâ yorumu ({ds.interpretation.model}{ds.interpretation.at ? `, ${formatDateTime(ds.interpretation.at)}` : ""}); yalnızca yukarıdaki hesaplanmış değerlerden yazıldı. Kontrol edin.</small>
              </>
            ) : (
              <p className="muted-text">{aiAvailable ? "Henüz yorum yok." : "Yapay zekâ yapılandırılmadığı için yorum yazılamıyor; özet ve metrikler yine de hesaplanır."}</p>
            )}
          </div>
          {manage && (
            <div className="data-source-actions">
              {aiAvailable && (
                <button className="outline-button" type="button" onClick={interpret} disabled={!!busy}>
                  {busy === "interpret" ? <LoadingMark /> : <AppIcon name="message" />}{ds.interpretation ? "Yeniden Yorumla" : "Yorumla"}
                </button>
              )}
              <button className="text-button" type="button" onClick={() => setEditing(true)}>Eşleştirmeyi düzenle</button>
              <button className="text-button danger" type="button" onClick={remove} disabled={!!busy}>Sil</button>
            </div>
          )}
        </>
      ) : (
        <p className="muted-text">Sütun eşleştirmesi kurum sahibi veya yönetici tarafından onaylanınca özet ve metrikler görünür.</p>
      )}
      {editing && manage && ds.status === "NEEDS_REVIEW" && (
        <div className="data-source-actions"><button className="text-button danger" type="button" onClick={remove} disabled={!!busy}>Tabloyu sil</button></div>
      )}
    </article>
  );
}

export function OwnDataSection({ eventId }: { eventId: string }) {
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const datasets = useDatasets(eventId);
  const metrics = useEventMetrics(eventId);
  const manage = can("data.manage");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ fileName: string; content: string; result: DatasetUploadResult } | null>(null);

  const metricValues = useMemo(() => new Map((metrics.data?.values ?? []).map((v) => [v.id, v])), [metrics.data]);
  const fedBy = (ds: DatasetInfo) => {
    const ids = new Set(ds.mapping.filter((m) => m.role.startsWith("measure:"))
      .flatMap((m) => MEASURES.find((x) => x.key === m.role.slice(8))?.feeds ?? []));
    return [...ids].filter((id) => (DATASET_KPI_IDS as readonly string[]).includes(id)).map((id) => metricValues.get(id) ?? { id, value: null });
  };

  async function send(fileName: string, content: string, sheet: string | null, replaceId?: string) {
    setBusy(true);
    try {
      // Switching sheets replaces the table only while it is still unreviewed; a confirmed table is kept and the other
      // sheet is added next to it.
      const replaced = replaceId && datasets.data?.datasets.find((d) => d.id === replaceId)?.status === "NEEDS_REVIEW";
      if (replaced) await api(`/api/datasets/${replaceId}`, { method: "DELETE", query: { organizationId: orgId } });
      const result = await api<DatasetUploadResult>(`/api/events/${eventId}/datasets`, { method: "POST", body: { organizationId: orgId, fileName, content, sheet } });
      setPending(result.sheets.length > 1 ? { fileName, content, result } : null);
      toast(`${formatNumber(result.rows)} satır, ${result.columns} sütun okundu. Sütunların anlamını kontrol edip onaylayın.`);
      for (const n of result.notes) toast(n, "error");
      await qc.invalidateQueries({ queryKey: keys.datasets(eventId) });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_BYTES) return toast("Dosya en fazla 6 MB olabilir.", "error");
    const content = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    await send(file.name, content, null);
  }

  return (
    <section className="analytics-surveys own-data">
      <SectionHeading eyebrow="KENDİ VERİLERİNİZ" title="Excel veya CSV'den analize ekleyin">
        {manage && (
          <label className="outline-button file-button">
            {busy ? <LoadingMark /> : <AppIcon name="plus" />}Dosya Yükle
            <input type="file" accept=".xlsx,.xlsm,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={onFile} disabled={busy} />
          </label>
        )}
      </SectionHeading>
      <p className="section-intro">
        Atık ve karbon, olay ve şikâyet kayıtları, oturum katılımı, B2B görüşmeler, yayın izlenmesi, esnaf satışları gibi tablolarınızı yükleyin.
        Sistem sütunları okur, her sütunun anlamını önerir{datasets.data?.aiAvailable ? " (yapay zekâ yalnızca sütun adlarını ve özet istatistikleri görür, satırları görmez)" : ""};
        siz onaylayınca değerler katalogdaki metriklere, Analizler ve Raporlar'a girer. Ad, e-posta, telefon gibi sütunlar alınmaz.
      </p>
      {pending && (
        <InlineNotice tone="neutral">
          &ldquo;{pending.fileName}&rdquo; dosyasında {pending.result.sheets.length} sayfa var; &ldquo;{pending.result.sheet}&rdquo; okundu. Başka bir sayfa:{" "}
          {pending.result.sheets.filter((s) => s !== pending.result.sheet).map((s) => (
            <button key={s} className="text-button" type="button" disabled={busy} onClick={() => send(pending.fileName, pending.content, s, pending.result.id)}>{s}</button>
          ))}
        </InlineNotice>
      )}
      {datasets.isPending ? <SkeletonRows rows={2} label="Tablolar yükleniyor" />
        : datasets.isError ? <InlineNotice tone="error">{errorMessage(datasets.error)}</InlineNotice>
        : datasets.data.datasets.length === 0 ? <p className="muted-text">Henüz yüklenmiş tablo yok.</p>
        : (
          <div className="dataset-list">
            {datasets.data.datasets.map((d) => (
              <DatasetCard key={`${d.id}-${d.status}-${d.mapping.map((m) => m.role).join()}`} ds={d} aiAvailable={datasets.data.aiAvailable} manage={manage} metricsFed={fedBy(d)} />
            ))}
          </div>
        )}
    </section>
  );
}
