"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { useEventDetail, useOrg, useProposals } from "@/lib/api/hooks";
import type { ProposalStatus } from "@/lib/api/types";
import { EmptyState, ErrorState, LoadingMark, SkeletonRows, useToast } from "@/components/eip/ui";
import { ProposalCard, summarize } from "@/components/eip/proposals";
import { useEventId } from "@/components/eip/workspace";

const FILTERS: { key: string; label: string; statuses: ProposalStatus[] }[] = [
  { key: "pending", label: "Bekleyen", statuses: ["PENDING"] },
  { key: "applied", label: "Uygulanan", statuses: ["APPLIED"] },
  { key: "rejected", label: "Reddedilen", statuses: ["REJECTED", "EXPIRED", "FAILED"] },
];

export default function SuggestionsPage() {
  const eventId = useEventId();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const event = useEventDetail(eventId);
  const [waitingSections, setWaitingSections] = useState(false);
  const proposals = useProposals(eventId, { poll: waitingSections ? 4000 : false });
  const [filter, setFilter] = useState("pending");
  const [regenerating, setRegenerating] = useState(false);

  // Arriving from "Yeni etkinlik": the section cards are still being generated → poll for a few minutes.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("hazirlaniyor") !== "1") return;
    setWaitingSections(true);
    const t = window.setTimeout(() => setWaitingSections(false), 4 * 60_000);
    return () => window.clearTimeout(t);
  }, []);
  const pendingCount = (proposals.data ?? []).filter((p) => p.status === "PENDING").length;
  useEffect(() => {
    // three section cards (tasks, KPIs, surveys) → stop polling once they are all in
    if (waitingSections && pendingCount >= 3) setWaitingSections(false);
  }, [waitingSections, pendingCount]);

  const all = useMemo(() => proposals.data ?? [], [proposals.data]);
  const visible = all.filter((p) => FILTERS.find((f) => f.key === filter)!.statuses.includes(p.status));
  const fromBlueprint = !!event.data?.fromBlueprint;

  async function refresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["proposals", eventId] }),
      qc.invalidateQueries({ queryKey: ["event"] }),
      qc.invalidateQueries({ queryKey: ["tasks", eventId] }),
      qc.invalidateQueries({ queryKey: ["kpis", eventId] }),
      qc.invalidateQueries({ queryKey: ["surveys", eventId] }),
    ]);
  }

  async function regenerate() {
    setRegenerating(true);
    try {
      await api("/api/ai/blueprint/sections", { method: "POST", body: { organizationId: orgId, eventId } });
      toast("Görev, KPI ve anket önerileri hazırlanıyor. Kartlar birkaç dakika içinde burada görünür.");
      setWaitingSections(true);
      setFilter("pending");
      window.setTimeout(() => setWaitingSections(false), 4 * 60_000);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <section className="suggestions-content">
      <div className="suggestions-toolbar">
        <div className="segment-control" role="tablist" aria-label="Önerileri filtrele">
          {FILTERS.map((f) => (
            <button
              className={filter === f.key ? "active" : ""}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              key={f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label} {all.filter((p) => f.statuses.includes(p.status)).length}
            </button>
          ))}
        </div>
        {fromBlueprint && can("blueprint.generate") && (
          <button className="outline-button rebuild-button" type="button" onClick={regenerate} disabled={regenerating}>
            {regenerating && <LoadingMark />}
            Bölümleri Yeniden Oluştur
          </button>
        )}
      </div>

      {waitingSections && (
        <div className="generating-banner" role="status">
          <span className="indeterminate-line" aria-hidden="true"><span /></span>
          Plan önerisi bölümleri hazırlanıyor; yeni kartlar otomatik olarak listelenecek.
        </div>
      )}

      <div className="proposal-list">
        {proposals.isPending ? (
          <SkeletonRows rows={3} label="Öneriler yükleniyor" />
        ) : proposals.isError ? (
          <ErrorState error={proposals.error} onRetry={() => proposals.refetch()} />
        ) : visible.length === 0 ? (
          <EmptyState
            title={
              filter === "pending"
                ? fromBlueprint
                  ? "Bekleyen öneri yok. Yeni görev, KPI ve anket önerileri için “Bölümleri Yeniden Oluştur”u kullanın."
                  : "Bu etkinlik plan önerisiyle oluşturulmadığı için öneri kartı yok."
                : "Bu filtrede öneri yok."
            }
          />
        ) : (
          visible.map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              onDecided={async (r) => {
                toast(r.action === "apply" ? summarize(r.summary) : "Öneri reddedildi.");
                await refresh();
              }}
            />
          ))
        )}
      </div>
    </section>
  );
}
