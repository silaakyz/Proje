"use client";
/** KPI building blocks: evidence badge (K/S/T from the organization's KPI reference) and the grouped results panel. */
import { useState } from "react";
import type { KpiValue } from "@/lib/api/types";
import { KPI_BY_ID, KPI_GROUPS, KPI_SOURCES, type KpiDefinition } from "@/lib/kpi/catalog";
import { formatKpiValue } from "@/lib/ui/format";

export const EVIDENCE_LABEL: Record<string, string> = {
  K: "Kaynaktan doğrulandı",
  S: "Standart tanım",
  T: "Tasarım kararı",
};

export function EvidenceBadge({ def }: { def: KpiDefinition }) {
  const refs = def.refs?.length ? ` [${def.refs.join(", ")}]` : "";
  const title = def.evidence.map((e) => EVIDENCE_LABEL[e]).join(" + ") + refs + (def.decision ? ` — karar: ${def.decision}` : "");
  return (
    <span className="evidence-badges" title={title}>
      {def.evidence.map((e) => (
        <span className={`evidence-badge evidence-${e}`} key={e}>
          {e}
          {e === "K" && def.refs?.length ? `[${def.refs.join(",")}]` : ""}
        </span>
      ))}
    </span>
  );
}

export function SourceLinks({ refs }: { refs: number[] }) {
  return (
    <>
      {refs.map((r) => (
        <a key={r} href={KPI_SOURCES[r]?.url} target="_blank" rel="noreferrer" title={KPI_SOURCES[r]?.title}>
          [{r}]
        </a>
      ))}
    </>
  );
}

function MetricCard({ value }: { value: KpiValue }) {
  const def = KPI_BY_ID.get(value.id)!;
  const [open, setOpen] = useState(false);
  return (
    <article className={`metric-card${value.value === null ? " empty" : ""}`}>
      <header>
        <span>{def.name}</span>
        <EvidenceBadge def={def} />
      </header>
      <strong>
        {value.value === null ? (value.reason === "zero_denominator" ? "Payda sıfır" : "Veri yok") : formatKpiValue(value.value, def.unit, def.id)}
      </strong>
      <small>
        {value.interval ? `%95 aralık: ${formatKpiValue(value.interval[0], def.unit, def.id)} – ${formatKpiValue(value.interval[1], def.unit, def.id)} · ` : ""}
        {value.n !== undefined ? `n = ${value.n.toLocaleString("tr-TR")}` : ""}
        {value.note ? ` · ${value.note}` : ""}
      </small>
      <button type="button" className="text-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? "Formülü gizle" : "Formül"}
      </button>
      {open && (
        <p className="metric-formula">
          <code>{def.formula}</code>
          {def.refs?.length ? (
            <>
              {" "}
              Kaynak: <SourceLinks refs={def.refs} />
            </>
          ) : null}
          {def.decision ? <em> Karar: {def.decision}</em> : null}
        </p>
      )}
    </article>
  );
}

/** Computed metrics grouped like the reference document; groups without any value are left out. */
export function MetricsPanel({ values, hideEmpty = false }: { values: KpiValue[]; hideEmpty?: boolean }) {
  const byGroup = KPI_GROUPS.map((g) => ({
    ...g,
    items: values.filter((v) => KPI_BY_ID.get(v.id)?.group === g.key && (!hideEmpty || v.value !== null)),
  })).filter((g) => g.items.length > 0);
  return (
    <div className="metrics-panel">
      {byGroup.map((g) => (
        <section key={g.key} className="metrics-group">
          <h3 className="sub-heading">{g.title}</h3>
          <div className="metric-grid">
            {g.items.map((v) => (
              <MetricCard value={v} key={v.id} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
