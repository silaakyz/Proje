"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api/client";
import { useEventDetail, useOrg, useSurveys } from "@/lib/api/hooks";
import { formatNumber } from "@/lib/ui/format";
import { AUDIENCE_LABEL, SURVEY_STATUS_BADGE } from "@/lib/ui/labels";
import { EmptyState, ErrorState, LoadingMark, SkeletonRows, StatusBadge, useToast } from "@/components/eip/ui";
import { SurveyFlowCard } from "@/components/eip/survey-flow";
import { useEventId } from "@/components/eip/workspace";

export default function SurveysPage() {
  const eventId = useEventId();
  const router = useRouter();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const event = useEventDetail(eventId);
  const surveys = useSurveys(eventId);
  const [requesting, setRequesting] = useState(false);

  async function requestSurveys() {
    setRequesting(true);
    try {
      await api("/api/ai/blueprint/sections", { method: "POST", body: { organizationId: orgId, eventId, sections: ["surveys"] } });
      toast("Anket önerisi hazırlanıyor. Hazır olduğunda Öneriler sekmesinde onayınıza sunulur.");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setRequesting(false);
    }
  }

  return (
    <section className="survey-list-section">
      <div className="survey-list-heading">
        <div>
          <p className="eyebrow">ANKETLER</p>
          <h2>Ölçüm formları</h2>
        </div>
        {event.data?.fromBlueprint && can("blueprint.generate") && (
          <button className="primary-button" type="button" onClick={requestSurveys} disabled={requesting}>
            {requesting && <LoadingMark />}
            Anket Önerisi Hazırla
          </button>
        )}
      </div>

      {can("survey.manage") && (surveys.data?.length ?? 0) > 0 && <SurveyFlowCard eventId={eventId} />}

      {surveys.isPending ? (
        <SkeletonRows rows={2} label="Anketler yükleniyor" />
      ) : surveys.isError ? (
        <ErrorState error={surveys.error} onRetry={() => surveys.refetch()} />
      ) : !surveys.data.length ? (
        <EmptyState title="Henüz anket yok. Anketler plan önerisinden gelir; ölçüm için gerekli sorular otomatik eklenir." />
      ) : (
        <div className="survey-list">
          {surveys.data.map((s) => {
            const progress = s.targetResponses ? Math.min(100, (s.responses / s.targetResponses) * 100) : 0;
            return (
              <button className="survey-row" type="button" key={s.id} onClick={() => router.push(`/etkinlikler/${eventId}/anketler/${s.id}`)}>
                <span className="survey-main">
                  <strong>{s.title}</strong>
                  <span>{AUDIENCE_LABEL[s.audience] ?? s.audience}</span>
                </span>
                <span className="survey-version">v{s.version}</span>
                <StatusBadge status={SURVEY_STATUS_BADGE[s.status]} />
                <span className="survey-question-count">{s.questions} soru</span>
                <span className="survey-response-progress">
                  <span>
                    {formatNumber(s.responses)}
                    {s.targetResponses ? ` / ${formatNumber(s.targetResponses)}` : ""} yanıt
                  </span>
                  <i aria-hidden="true">
                    <i style={{ width: `${progress}%` }} />
                  </i>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
