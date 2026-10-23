"use client";
/** Plan-proposal cards: what the AI suggested, ticked per operation, applied or rejected by an owner/admin. */
import { useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { useOrg } from "@/lib/api/hooks";
import type { Proposal, ProposalOperation } from "@/lib/api/types";
import { formatDate, formatNumber } from "@/lib/ui/format";
import {
  AUDIENCE_LABEL, EVENT_FORMAT_LABEL, PRIORITY_LABEL, PROPOSAL_KIND_LABEL, PROPOSAL_STATUS_BADGE, TASK_BOARD_LABEL, metricInfo,
  moduleLabel, workstreamLabel,
} from "@/lib/ui/labels";
import { InlineNotice, LoadingMark, StatusBadge } from "@/components/eip/ui";

export interface ApplyResult {
  status: string;
  eventId: string;
  applied: number;
  created: Record<string, number>;
  updated: Record<string, number>;
  preserved: Record<string, number>;
}

const ENTITY_LABEL: Record<string, string> = { event: "etkinlik", task: "görev", kpi: "KPI", survey: "anket", task_patch: "görev" };

/** "4 öğe oluşturuldu, 1 güncellendi, 1 korundu." */
export function summarize(r: ApplyResult) {
  const sum = (o: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + b, 0);
  const parts = [`${sum(r.created)} öğe oluşturuldu`];
  if (sum(r.updated)) parts.push(`${sum(r.updated)} güncellendi`);
  if (sum(r.preserved)) parts.push(`${sum(r.preserved)} korundu`);
  return `${parts.join(", ")}.`;
}

/** One line per operation; `kind` add (+) or update (~). */
export function describeOperation(op: ProposalOperation): { kind: "add" | "update"; text: string; detail?: string } {
  const d = (op.data ?? {}) as Record<string, unknown>;
  switch (op.entity) {
    case "event": {
      const ev = (d.event ?? {}) as Record<string, unknown>;
      return { kind: "add", text: `Etkinlik oluştur: ${String(ev.title ?? "")}`, detail: [ev.format ? EVENT_FORMAT_LABEL[String(ev.format)] : null, ev.city, ev.startDate ? formatDate(String(ev.startDate)) : null].filter(Boolean).join(" · ") };
    }
    case "task": {
      const offset = typeof d.dueOffsetDays === "number" ? (d.dueOffsetDays < 0 ? `etkinlikten ${-d.dueOffsetDays} gün önce` : d.dueOffsetDays === 0 ? "etkinlik günü" : `etkinlikten ${d.dueOffsetDays} gün sonra`) : null;
      return {
        kind: "add",
        text: `Görev ekle: ${String(d.title ?? "")}`,
        detail: [d.board ? TASK_BOARD_LABEL[String(d.board)] : null, d.workstream ? workstreamLabel(String(d.workstream)) : null, d.priority ? PRIORITY_LABEL[String(d.priority)] : null, offset].filter(Boolean).join(" · "),
      };
    }
    case "kpi": {
      const info = metricInfo(String(d.metricKey ?? ""));
      return { kind: "add", text: `KPI ekle: ${info.name}`, detail: d.target !== null && d.target !== undefined ? `Hedef ${formatNumber(Number(d.target))} ${info.unit}` : "Hedef belirtilmedi" };
    }
    case "survey": {
      const qs = Array.isArray(d.questions) ? d.questions.length : 0;
      return { kind: "add", text: `Anket ekle: ${String(d.title ?? "")}`, detail: `${AUDIENCE_LABEL[String(d.audience)] ?? d.audience} · ${qs} soru` };
    }
    case "task_patch":
      return { kind: "update", text: `Görevi güncelle`, detail: Object.keys(op.patch ?? {}).join(", ") };
    default:
      return { kind: "add", text: `${ENTITY_LABEL[op.entity] ?? op.entity} ekle` };
  }
}

/** Expanded view of a blueprint.core card: the event profile the AI read from the description. */
export function CoreDetails({ op }: { op: ProposalOperation }) {
  const d = (op.data ?? {}) as {
    event?: Record<string, unknown>; objectives?: { text: string; origin: string }[]; modules?: { key: string; source: string; reason: string | null }[];
    stakeholders?: { name: string; role: string | null; origin: string }[]; assumptions?: string[]; clarifications?: { question: string; blocking: boolean }[];
    audience?: string | null; budgetTotalMinor?: number | null;
  };
  const ev = d.event ?? {};
  const rows: [string, string][] = [
    ["Format", ev.format ? EVENT_FORMAT_LABEL[String(ev.format)] ?? String(ev.format) : "—"],
    ["Şehir", [ev.city, ev.nuts2Code].filter(Boolean).join(" · ") || "Belirtilmedi"],
    ["Tarih", ev.startDate ? `${formatDate(String(ev.startDate))}${ev.durationDays ? ` · ${ev.durationDays} gün` : ""}` : "Belirtilmedi"],
    ["Beklenen katılım", ev.expectedAttendance ? formatNumber(Number(ev.expectedAttendance)) : "Belirtilmedi"],
    ["Hedef kitle", d.audience ?? "Belirtilmedi"],
    ["Bütçe", d.budgetTotalMinor ? `₺ ${formatNumber(Math.round(d.budgetTotalMinor / 100))}` : "Belirtilmedi"],
  ];
  return (
    <div className="blueprint-sections">
      <article className="blueprint-section">
        <div>
          <h2>Etkinlik detayları</h2>
          <dl className="profile-list compact">
            {rows.map(([k, v]) => (
              <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>
        </div>
      </article>
      {!!d.objectives?.length && (
        <article className="blueprint-section">
          <div>
            <h2>Hedefler</h2>
            <ul className="plain-list">{d.objectives.map((o, i) => <li key={i}>{o.text}{o.origin === "INFERRED" && <em className="inferred-tag"> öneri</em>}</li>)}</ul>
          </div>
        </article>
      )}
      {!!d.modules?.length && (
        <article className="blueprint-section">
          <div>
            <h2>Önerilen modüller</h2>
            <p className="module-chips">{d.modules.map((m) => <span key={m.key} title={m.reason ?? undefined}>{moduleLabel(m.key)}</span>)}</p>
          </div>
        </article>
      )}
      {!!d.stakeholders?.length && (
        <article className="blueprint-section">
          <div>
            <h2>Paydaşlar</h2>
            <ul className="plain-list">{d.stakeholders.map((s, i) => <li key={i}>{s.name}{s.role ? ` — ${s.role}` : ""}</li>)}</ul>
          </div>
        </article>
      )}
      {!!d.assumptions?.length && (
        <article className="blueprint-section">
          <div>
            <h2>Varsayımlar</h2>
            <ul className="plain-list">{d.assumptions.map((a, i) => <li key={i}>{a} <em className="unverified-tag">Doğrulanmamış</em></li>)}</ul>
          </div>
        </article>
      )}
      {!!d.clarifications?.length && (
        <article className="blueprint-section">
          <div>
            <h2>Netleştirilmesi gerekenler</h2>
            <ul className="plain-list">{d.clarifications.map((c, i) => <li key={i}>{c.question}</li>)}</ul>
          </div>
        </article>
      )}
    </div>
  );
}

export function ProposalCard({
  proposal,
  onDecided,
  defaultOpen = false,
}: {
  proposal: Proposal;
  onDecided: (result: { action: "apply"; summary: ApplyResult } | { action: "reject" }) => void;
  defaultOpen?: boolean;
}) {
  const { orgId, can } = useOrg();
  const pending = proposal.status === "PENDING";
  const decide = pending && can("proposal.decide");
  const ops = useMemo(() => proposal.operations.map(describeOperation), [proposal.operations]);
  const [selected, setSelected] = useState<boolean[]>(() => proposal.operations.map(() => true));
  const [open, setOpen] = useState(defaultOpen || proposal.operations.length <= 8);
  const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
  const [error, setError] = useState("");
  const [showWhy, setShowWhy] = useState(false);
  const count = selected.filter(Boolean).length;
  const isCore = proposal.kind === "blueprint.core";
  const shown = open ? ops : ops.slice(0, 6);

  async function apply() {
    setBusy("apply");
    setError("");
    try {
      const opIndexes = selected.length === count ? undefined : selected.flatMap((s, i) => (s ? [i] : []));
      const summary = await api<ApplyResult>(`/api/proposals/${proposal.id}`, { method: "POST", body: { action: "apply", organizationId: orgId, opIndexes } });
      onDecided({ action: "apply", summary });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    setError("");
    try {
      await api(`/api/proposals/${proposal.id}`, { method: "POST", body: { action: "reject", organizationId: orgId } });
      onDecided({ action: "reject" });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className="proposal-card task-proposal-card">
      <div className="proposal-card-heading">
        <p className="eyebrow">{PROPOSAL_KIND_LABEL[proposal.kind] ?? "PLAN ÖNERİSİ"}</p>
        <StatusBadge status={PROPOSAL_STATUS_BADGE[proposal.status]} />
      </div>
      <h2>{proposal.title}</h2>
      {proposal.rationale && (
        <p className="proposal-rationale">
          {proposal.rationale.length > 240 && !showWhy ? `${proposal.rationale.slice(0, 220).trimEnd()}… ` : `${proposal.rationale} `}
          {proposal.rationale.length > 240 && (
            <button type="button" className="text-link" onClick={() => setShowWhy((v) => !v)}>
              {showWhy ? "Kısalt" : "Tümünü göster"}
            </button>
          )}
        </p>
      )}
      <p className="proposal-expiry">
        {pending && proposal.expiresAt ? `Son geçerlilik: ${formatDate(proposal.expiresAt.slice(0, 10))}` : null}
        {!pending && proposal.decidedAt ? `Karar: ${formatDate(proposal.decidedAt.slice(0, 10))}` : null}
        {proposal.status === "FAILED" && proposal.errorMessage ? ` · ${proposal.errorMessage}` : null}
      </p>

      {isCore && proposal.operations[0] ? (
        <CoreDetails op={proposal.operations[0]} />
      ) : (
        <div className="operation-list">
          {shown.map((op, index) => (
            <label className="operation-item" key={index}>
              <input
                type="checkbox"
                checked={selected[index]}
                disabled={!decide}
                onChange={() => setSelected((cur) => cur.map((v, i) => (i === index ? !v : v)))}
              />
              <span className={`operation-sign operation-${op.kind}`} aria-hidden="true">
                {op.kind === "add" ? "+" : "~"}
              </span>
              <span>
                {op.text}
                {op.detail && <small className="operation-detail">{op.detail}</small>}
              </span>
            </label>
          ))}
          {ops.length > shown.length && (
            <button type="button" className="text-link show-more" onClick={() => setOpen(true)}>
              {ops.length - shown.length} madde daha göster
            </button>
          )}
        </div>
      )}

      {error && <InlineNotice tone="error">{error}</InlineNotice>}

      {decide && (
        <footer className="proposal-card-footer">
          <p>{isCore ? "Onaylandığında etkinlik oluşturulur" : `${count} / ${ops.length} madde seçili`}</p>
          <div>
            <button className="ghost-button proposal-reject" type="button" onClick={reject} disabled={busy !== null}>
              {busy === "reject" && <LoadingMark />}
              Reddet
            </button>
            <button className="primary-button apply-selection" type="button" disabled={count === 0 || busy !== null} onClick={apply}>
              {busy === "apply" && <LoadingMark />}
              {isCore ? "Planı Onayla ve Oluştur" : "Seçilenleri Uygula"}
            </button>
          </div>
        </footer>
      )}
      {pending && !can("proposal.decide") && <p className="muted-text">Önerileri kurum sahibi veya yönetici onaylar.</p>}
    </article>
  );
}
