"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useImpact, useImpactInputs, useImpactRuns, useMultiplierSets, useOrg } from "@/lib/api/hooks";
import type { AttributionMethod, ImpactLevel, ImpactRun, SourcedValue } from "@/lib/api/types";
import { formatDateTime, formatDecimal, formatNumber, formatTry, parseTrNumber } from "@/lib/ui/format";
import { ATTENDANCE_BASIS_LABEL, IMPACT_CHECK_LABEL, IMPACT_LEVEL_LABEL, IMPACT_LEVELS, SPEND_CATEGORY_LABEL } from "@/lib/ui/labels";
import { AppIcon, EmptyState, ErrorState, InlineNotice, LoadingMark, Modal, SkeletonRows, useToast } from "@/components/eip/ui";
import { useEventId } from "@/components/eip/workspace";

const ADJUSTMENTS = [
  { key: "deadweight", label: "Ölü ağırlık (deadweight)", help: "Etkinlik olmasa da gerçekleşecek harcama payı" },
  { key: "displacement", label: "Yer değiştirme (displacement)", help: "Bölgedeki başka harcamalardan kayan pay" },
  { key: "leakage", label: "Sızıntı (leakage)", help: "Bölge dışına çıkan harcama payı" },
] as const;
type AdjKey = (typeof ADJUSTMENTS)[number]["key"];

/** The "required" column: a minimum only for sample-size checks; region / year / coverage in words. */
function requirementText(check: string, required: number | string | undefined, passed: boolean) {
  if (required === undefined) return passed ? "tamam" : "gerekli";
  if (check.startsWith("min_") && typeof required === "number") return `en az ${formatNumber(required)}`;
  if (check === "multiplier_set_matches_region") return `bölge ${required}`;
  if (check === "price_years_match") return `fiyat yılı ${required}`;
  if (check === "multipliers_cover_spend_categories") return "harcama kategorileri";
  return String(required).length > 24 ? "gerekli" : String(required);
}

function InputsForm({ eventId }: { eventId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const inputs = useImpactInputs(eventId);
  const sets = useMultiplierSets();
  const editable = can("impact.manage");
  const [priceYear, setPriceYear] = useState("2026");
  const [method, setMethod] = useState<AttributionMethod>("SURVEY_STRICT");
  const [adj, setAdj] = useState<Record<AdjKey, { value: string; source: string }>>({
    deadweight: { value: "", source: "" }, displacement: { value: "", source: "" }, leakage: { value: "", source: "" },
  });
  const [setId, setSetId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const i = inputs.data;
    if (!i) return;
    const pair = (v: SourcedValue | null) => ({ value: v ? formatDecimal(v.value) : "", source: v?.source ?? "" });
    setPriceYear(String(i.priceYear));
    setMethod(i.attributionMethod ?? "SURVEY_STRICT");
    setAdj({ deadweight: pair(i.deadweight), displacement: pair(i.displacement), leakage: pair(i.leakage) });
    setSetId(i.multiplierSetId ?? "");
  }, [inputs.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    const year = Number(priceYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return setError("Fiyat yılı 2000–2100 arasında olmalı.");
    const body: Record<string, unknown> = { organizationId: orgId, priceYear: year, attributionMethod: method, multiplierSetId: setId || null };
    for (const a of ADJUSTMENTS) {
      const v = adj[a.key];
      if (a.key === "deadweight" && method === "SURVEY_STRICT") {
        body.deadweight = null; // measured from the survey instead
        continue;
      }
      if (a.key === "deadweight" && !v.value.trim()) return setError("Kayıtlı oran yönteminde ölü ağırlık değeri ve kaynağı gerekli.");
      if (!v.value.trim() && !v.source.trim()) {
        body[a.key] = null;
        continue;
      }
      const n = parseTrNumber(v.value);
      if (n === null || Number.isNaN(n) || n < 0 || n > 1) return setError(`${a.label}: 0 ile 1 arasında bir değer girin (örn. 0,15).`);
      if (v.source.trim().length < 10) return setError(`${a.label}: kaynak en az 10 karakter olmalı.`);
      body[a.key] = { value: n, source: v.source.trim() };
    }
    setSaving(true);
    try {
      await api(`/api/events/${eventId}/impact/inputs`, { method: "PUT", body });
      toast("Girdiler kaydedildi.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.impactInputs(eventId) }), qc.invalidateQueries({ queryKey: ["impact", eventId] })]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="impact-section impact-inputs">
      <p className="eyebrow">GİRDİLER</p>
      <form onSubmit={save}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <div className="impact-form-row single-input-row">
          <label>
            <span>Fiyat yılı</span>
            <input type="number" min="2000" max="2100" value={priceYear} disabled={!editable} onChange={(e) => setPriceYear(e.target.value)} />
          </label>
        </div>
        <div className="impact-form-row single-input-row">
          <label>
            <span>Atfedilebilirlik</span>
            <select value={method} disabled={!editable} onChange={(e) => setMethod(e.target.value as AttributionMethod)}>
              <option value="SURVEY_STRICT">Anketten ölçülen (katı kural)</option>
              <option value="RECORDED_DEADWEIGHT">Kayıtlı ölü ağırlık oranı</option>
            </select>
            <small>
              {method === "SURVEY_STRICT"
                ? "Şehir dışından gelen, ana geliş nedeni etkinlik olan ve etkinlik olmasa gelmeyecek ziyaretçilerin harcaması; her harcama kalemi için ayrı."
                : "Etkinlik olmasa da gerçekleşecek harcama payını kaynağıyla girin."}
            </small>
          </label>
        </div>
        {ADJUSTMENTS.filter((a) => a.key !== "deadweight" || method === "RECORDED_DEADWEIGHT").map((a) => (
          <div className="impact-form-row adjustment-row" key={a.key}>
            <label>
              <span>{a.label}</span>
              <input
                type="text"
                inputMode="decimal"
                placeholder="örn. 0,15"
                value={adj[a.key].value}
                disabled={!editable}
                aria-label={`${a.label} değeri`}
                onChange={(e) => setAdj((s) => ({ ...s, [a.key]: { ...s[a.key], value: e.target.value } }))}
              />
              <small>{a.help}</small>
            </label>
            <label>
              <span>Kaynak</span>
              <input
                type="text"
                placeholder="Değerin dayandığı çalışma veya veri seti"
                value={adj[a.key].source}
                disabled={!editable}
                onChange={(e) => setAdj((s) => ({ ...s, [a.key]: { ...s[a.key], source: e.target.value } }))}
              />
              <small>En az 10 karakter</small>
            </label>
          </div>
        ))}
        <div className="impact-form-row single-input-row">
          <label>
            <span>Çarpan seti</span>
            <select value={setId} disabled={!editable} onChange={(e) => setSetId(e.target.value)}>
              <option value="">Çarpan seti seçin</option>
              {(sets.data ?? []).map((m) => (
                <option value={m.id} key={m.id} disabled={!m.isActive}>
                  {m.name} · {m.nuts2Code ?? "Ulusal"} · {m.priceYear}
                  {m.isActive ? "" : " (pasif)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        {editable && (
          <button className="primary-button save-impact-inputs" type="submit" disabled={saving}>
            {saving && <LoadingMark />}
            Girdileri Kaydet
          </button>
        )}
      </form>
    </section>
  );
}

function RunDetailModal({ run, number, onClose }: { run: ImpactRun; number: number; onClose: () => void }) {
  const snap = run.inputSnapshot as { attendance?: { basis: string; value: number } | null; assumptions?: Record<string, unknown> | null };
  return (
    <Modal className="form-modal run-modal" labelledBy="run-title" onClose={onClose}>
      <p className="eyebrow">HESAPLAMA KAYDI #{number}</p>
      <h2 id="run-title">{run.achievedLevel ? IMPACT_LEVEL_LABEL[run.achievedLevel] : "Yetersiz veri"}</h2>
      <p className="muted-text">
        {formatDateTime(run.createdAt)} · motor {run.engineVersion} · kayıt {run.id.slice(0, 8)}
      </p>
      <dl className="profile-list compact">
        <div><dt>Katılım tabanı</dt><dd>{snap.attendance ? `${formatNumber(snap.attendance.value)} (${ATTENDANCE_BASIS_LABEL[snap.attendance.basis] ?? snap.attendance.basis})` : "—"}</dd></div>
        <div><dt>Örneklem</dt><dd>{formatNumber(run.sampleSize ?? 0)} harcama bildiren ziyaretçi</dd></div>
        {run.figures?.grossDirectSpend !== null && run.figures?.grossDirectSpend !== undefined && <div><dt>Brüt doğrudan harcama</dt><dd>{formatTry(run.figures.grossDirectSpend)}</dd></div>}
        {run.figures?.attributableSpend !== null && run.figures?.attributableSpend !== undefined && <div><dt>Atfedilebilir harcama</dt><dd>{formatTry(run.figures.attributableSpend)}</dd></div>}
        {run.figures?.totalOutputImpact !== null && run.figures?.totalOutputImpact !== undefined && <div><dt>Toplam çıktı etkisi</dt><dd>{formatTry(run.figures.totalOutputImpact)}</dd></div>}
      </dl>
      <div className="readiness-list compact-checks">
        {run.checks.map((c) => (
          <div className={c.passed ? "ready" : "missing"} key={`${c.level}-${c.check}`}>
            <span className="readiness-icon" aria-hidden="true"><AppIcon name={c.passed ? "check" : "close"} /></span>
            <strong>{IMPACT_CHECK_LABEL[c.check] ?? c.check}</strong>
            <span>{c.required !== undefined ? `gerekli ${c.required}` : ""}</span>
            <b>{c.actual === undefined || c.actual === null ? "" : String(c.actual)}</b>
          </div>
        ))}
      </div>
      <div className="form-modal-actions">
        <button className="ghost-button" type="button" onClick={onClose}>
          Kapat
        </button>
      </div>
    </Modal>
  );
}

export default function ImpactPage() {
  const eventId = useEventId();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const [level, setLevel] = useState<ImpactLevel>("ECONOMIC_IMPACT");
  const readiness = useImpact(eventId, level);
  const runs = useImpactRuns(eventId);
  const [running, setRunning] = useState(false);
  const [detail, setDetail] = useState<ImpactRun | null>(null);

  const latest = runs.data?.[0] ?? null;
  const runNumber = (r: ImpactRun) => (runs.data ? runs.data.length - runs.data.indexOf(r) : 0);
  const categories = useMemo(() => {
    const by = latest?.breakdown?.byCategory ?? {};
    const rows = Object.entries(by).map(([k, v]) => ({ key: k, value: v.gross })).sort((a, b) => b.value - a.value);
    const max = rows[0]?.value ?? 0;
    return rows.map((r) => ({ ...r, pct: max > 0 ? (r.value / max) * 100 : 0 }));
  }, [latest]);

  async function run() {
    setRunning(true);
    try {
      const r = await api<{ run: ImpactRun }>(`/api/events/${eventId}/impact/runs`, { method: "POST", body: { organizationId: orgId, level } });
      toast(r.run.achievedLevel ? `Hesaplama kaydedildi: ${IMPACT_LEVEL_LABEL[r.run.achievedLevel]} seviyesine ulaşıldı.` : "Hesaplama kaydedildi; veri yetersiz olduğu için rakam üretilmedi.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.impactRuns(eventId) }), qc.invalidateQueries({ queryKey: ["impact", eventId] })]);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setRunning(false);
    }
  }

  const a = readiness.data?.assessment;
  const f = latest?.figures;

  return (
    <>
      <div className="impact-level-selector segment-control" role="tablist" aria-label="Hedef seviye">
        {IMPACT_LEVELS.map((l) => (
          <button className={level === l ? "active" : ""} type="button" role="tab" aria-selected={level === l} key={l} onClick={() => setLevel(l)}>
            {IMPACT_LEVEL_LABEL[l]}
          </button>
        ))}
      </div>

      <section className="impact-section readiness-section">
        <p className="eyebrow">HAZIRLIK</p>
        {readiness.isPending ? (
          <SkeletonRows rows={4} />
        ) : readiness.isError ? (
          <ErrorState error={readiness.error} onRetry={() => readiness.refetch()} />
        ) : (
          <>
            <div className="readiness-list">
              {a!.checks.map((c) => (
                <div className={c.passed ? "ready" : "missing"} key={`${c.level}-${c.check}`}>
                  <span className="readiness-icon" aria-hidden="true">
                    <AppIcon name={c.passed ? "check" : "close"} />
                  </span>
                  <strong>{IMPACT_CHECK_LABEL[c.check] ?? c.check}</strong>
                  <span>{requirementText(c.check, c.required, c.passed)}</span>
                  <b>
                    {c.check === "attendance_known" && readiness.data!.inputs.attendance
                      ? `${ATTENDANCE_BASIS_LABEL[readiness.data!.inputs.attendance.basis]} ${formatNumber(readiness.data!.inputs.attendance.value)}`
                      : typeof c.actual === "number"
                        ? formatNumber(c.actual)
                        : c.actual && String(c.actual).length <= 24
                          ? String(c.actual).replace(/^(CHECKIN|REGISTRATION|ORGANIZER_ESTIMATE)$/, (m) => ATTENDANCE_BASIS_LABEL[m] ?? m)
                          : c.passed ? "var" : "eksik"}
                  </b>
                </div>
              ))}
            </div>
            <p className="reached-level">
              Ulaşılan seviye: <strong>{a!.achievedLevel ? IMPACT_LEVEL_LABEL[a!.achievedLevel] : "Henüz yok"}</strong>
            </p>
            {readiness.data!.dataNotes.map((n) => (
              <p className="data-note" key={n}>{n}</p>
            ))}
          </>
        )}
      </section>

      <InputsForm eventId={eventId} />

      {can("impact.manage") && (
        <div className="run-calculation">
          <div>
            <button className="primary-button" type="button" onClick={run} disabled={running}>
              {running && <LoadingMark />}
              Hesaplamayı Çalıştır
            </button>
            <p>Her hesaplama, girdileriyle birlikte değiştirilemez bir kayıt olarak saklanır.</p>
          </div>
        </div>
      )}

      <section className="impact-section impact-results">
        <div className="result-section-heading">
          <p className="eyebrow">SONUÇ</p>
          <span>{latest ? `Son hesaplama · #${runNumber(latest)}` : "Henüz hesaplama yok"}</span>
        </div>

        {runs.isPending ? (
          <SkeletonRows rows={3} />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : !latest ? (
          <EmptyState title="Sonuçlar yalnızca kaydedilen hesaplamalardan gelir. Hazırlık koşulları sağlandığında hesaplamayı çalıştırın." />
        ) : (
          <>
            <div className="impact-figures">
              <div className={f?.grossDirectSpend == null ? "unavailable" : ""}>
                <span>Toplam ziyaretçi harcaması</span>
                <strong>{formatTry(f?.grossDirectSpend)}</strong>
                {f?.grossDirectSpend == null && <small>Bu seviye için veri eksik</small>}
              </div>
              <div className={f?.attributableSpend == null ? "unavailable" : ""}>
                <span>Atfedilebilir harcama</span>
                <strong>{formatTry(f?.attributableSpend)}</strong>
                {f?.attributableSpend == null && <small>Bu seviye için girdi eksik</small>}
              </div>
              <div className={f?.totalOutputImpact == null ? "unavailable" : ""}>
                <span>Ekonomik etki (toplam çıktı)</span>
                <strong>{formatTry(f?.totalOutputImpact)}</strong>
                {f?.totalOutputImpact == null ? (
                  <small>Bu seviye için girdi eksik</small>
                ) : (
                  <small>
                    Katma değer {formatTry(f.totalValueAdded)} · gelir {formatTry(f.totalIncome)} · {f.totalEmploymentFte === null ? "istihdam hesaplanmadı" : `${formatDecimal(f.totalEmploymentFte)} TZE istihdam`}
                  </small>
                )}
              </div>
            </div>

            {categories.length > 0 && (
              <figure className="spend-chart">
                <div className="spend-bars">
                  {categories.map((c) => (
                    <div className="spend-bar-row" key={c.key}>
                      <span>{SPEND_CATEGORY_LABEL[c.key] ?? c.key}</span>
                      <i>
                        <i style={{ width: `${c.pct}%` }} />
                      </i>
                      <strong>{formatTry(c.value)}</strong>
                    </div>
                  ))}
                </div>
                {f?.totalOutputImpact != null && <p className="impact-formula">ΔX = (I − A)⁻¹ · ΔY</p>}
                {latest.breakdown?.attribution?.method === "SURVEY_STRICT" && (
                  <p className="impact-attribution-note">
                    Atfedilebilirlik ankette ölçüldü ({formatNumber(latest.breakdown.attribution.respondents)} yanıtlayan ziyaretçi). Katı kurala
                    uyan ziyaretçi payı: %{formatDecimal(latest.breakdown.attribution.strictRespondentShare * 100)}; atfedilebilir harcama payı:
                    %{formatDecimal(latest.breakdown.attribution.strictSpendShare * 100)}. Duyarlılık (geniş kural: ana neden etkinlik veya
                    etkinlik ve başka nedenler; &ldquo;belki&rdquo; diyenler dahil): atfedilebilir harcama
                    {" "}{formatTry(latest.breakdown.attribution.sensitivity.attributableSpend)}
                    {latest.breakdown.attribution.sensitivity.totalOutputImpact !== undefined
                      ? `, toplam çıktı ${formatTry(latest.breakdown.attribution.sensitivity.totalOutputImpact)}` : ""}.
                  </p>
                )}
                <figcaption>
                  Şekil 2 — Hesaplama kaydı #{runNumber(latest)}, brüt harcamanın kategorilere dağılımı
                  {latest.breakdown ? `; ziyaretçi payı %${formatDecimal(latest.breakdown.visitorShare * 100)}, ortalama ${formatDecimal(latest.breakdown.meanDaysPresent)} gün, kişi-gün başına ${formatTry(latest.breakdown.meanSpendPerVisitorDay)}` : ""}.
                  Tahmindir; doğrulanmış gerçek değer değildir.
                </figcaption>
              </figure>
            )}

            <div className="calculation-history">
              <h2>Hesaplama geçmişi</h2>
              <div>
                <table>
                  <thead>
                    <tr>
                      <th>No</th>
                      <th>Tarih</th>
                      <th>İstenen</th>
                      <th>Ulaşılan</th>
                      <th><span className="visually-hidden">İşlem</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.data.map((r) => (
                      <tr key={r.id}>
                        <td>#{runNumber(r)}</td>
                        <td>{formatDateTime(r.createdAt)}</td>
                        <td>{r.requestedLevel ? IMPACT_LEVEL_LABEL[r.requestedLevel] : "—"}</td>
                        <td>{r.achievedLevel ? IMPACT_LEVEL_LABEL[r.achievedLevel] : "Yetersiz veri"}</td>
                        <td>
                          <button type="button" onClick={() => setDetail(r)}>
                            Ayrıntı
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>
      {detail && <RunDetailModal run={detail} number={runNumber(detail)} onClose={() => setDetail(null)} />}
    </>
  );
}
