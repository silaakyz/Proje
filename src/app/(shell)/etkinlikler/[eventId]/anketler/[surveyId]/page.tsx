"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { keys, useOrg, useResponses, useSurvey } from "@/lib/api/hooks";
import type { SurveyDetail, SurveyResponse } from "@/lib/api/types";
import { formatDateTime, formatNumber, formatTry } from "@/lib/ui/format";
import { AUDIENCE_LABEL, CHANNEL_LABEL, QUESTION_TYPE_LABEL, SURVEY_STATUS_BADGE } from "@/lib/ui/labels";
import { AppIcon, EmptyState, ErrorState, InlineNotice, LoadingMark, Modal, SkeletonRows, StatusBadge, useCopy, useToast } from "@/components/eip/ui";
import { buildPayload, isVisible, QuestionInput, questionProblem, type Answers } from "@/components/eip/survey-form";
import { useEventId } from "@/components/eip/workspace";

function ShareSurveyModal({ token, onClose }: { token: string; onClose: () => void }) {
  const { copied, copy } = useCopy();
  const [svg, setSvg] = useState("");
  const url = typeof window === "undefined" ? `/anket/${token}` : `${window.location.origin}/anket/${token}`;
  useEffect(() => {
    QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 }).then(setSvg).catch(() => setSvg(""));
  }, [url]);
  return (
    <Modal className="share-survey-modal" labelledBy="share-survey-title" onClose={onClose}>
      <p className="eyebrow">ANKET BAĞLANTISI</p>
      <h2 id="share-survey-title">Bağlantıyı Paylaş</h2>
      <p>Ziyaretçiler bu bağlantıdan veya QR koddan ankete oturum açmadan erişir. Yanıtlar anonimdir.</p>
      <div className="share-survey-content">
        <div className="ticket-qr share-qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="Anket QR kodu" role="img" />
        <div>
          <label htmlFor="public-survey-link">Herkese açık bağlantı</label>
          <div>
            <input id="public-survey-link" type="text" readOnly value={url} onFocus={(e) => e.target.select()} />
            <button className="outline-button" type="button" onClick={() => copy(url)}>
              {copied ? "Kopyalandı" : "Kopyala"}
            </button>
          </div>
          <a className="text-link open-link" href={url} target="_blank" rel="noreferrer">
            Anketi yeni sekmede aç
          </a>
        </div>
      </div>
      <button className="ghost-button" type="button" onClick={onClose}>
        Kapat
      </button>
    </Modal>
  );
}

function ExcludeResponseModal({ response, surveyId, onClose }: { response: SurveyResponse; surveyId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId } = useOrg();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const excluding = !response.isExcluded;

  async function submit() {
    setBusy(true);
    try {
      await api(`/api/survey-responses/${response.id}`, {
        method: "PATCH",
        body: { organizationId: orgId, isExcluded: excluding, ...(excluding ? { reason: reason.trim() } : {}) },
      });
      toast(excluding ? "Yanıt hesaplamadan çıkarıldı." : "Yanıt yeniden dahil edildi.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.responses(surveyId) }), qc.invalidateQueries({ queryKey: keys.survey(surveyId) }), qc.invalidateQueries({ queryKey: ["surveys"] }), qc.invalidateQueries({ queryKey: ["impact"] })]);
      onClose();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal className="exclude-modal" labelledBy="exclude-title" onClose={onClose}>
      <p className="eyebrow">{excluding ? "YANITI HARİÇ TUT" : "YANITI DAHİL ET"}</p>
      <h2 id="exclude-title">{excluding ? "Bu yanıt hesaplamadan çıkarılsın mı?" : "Bu yanıt yeniden hesaplamaya alınsın mı?"}</h2>
      {excluding ? (
        <label>
          <span>Gerekçe</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Yanıtın neden hariç tutulacağını açıklayın." maxLength={500} />
        </label>
      ) : (
        <p className="muted-text">Hariç tutma gerekçesi: {response.exclusionReason ?? "—"}</p>
      )}
      <div>
        <button className="ghost-button" type="button" onClick={onClose}>
          Vazgeç
        </button>
        <button className={excluding ? "destructive-button" : "primary-button"} type="button" disabled={busy || (excluding && reason.trim().length < 3)} onClick={submit}>
          {busy && <LoadingMark />}
          {excluding ? "Yanıtı Hariç Tut" : "Yanıtı Dahil Et"}
        </button>
      </div>
    </Modal>
  );
}

function StaffResponseModal({ survey, onClose }: { survey: SurveyDetail; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId } = useOrg();
  const [answers, setAnswers] = useState<Answers>({});
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState("");
  const [busy, setBusy] = useState(false);
  const shown = survey.questions.filter((q) => isVisible(q, answers));

  async function submit() {
    const problems: Record<string, string> = {};
    for (const q of shown) {
      const p = questionProblem(q, answers[q.key], consent);
      if (p) problems[q.key] = p;
    }
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    setServerError("");
    try {
      await api(`/api/surveys/${survey.id}/responses`, { method: "POST", body: { organizationId: orgId, ...buildPayload(survey.questions, answers, consent) } });
      toast("Yanıt kaydedildi.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.responses(survey.id) }), qc.invalidateQueries({ queryKey: keys.survey(survey.id) }), qc.invalidateQueries({ queryKey: ["surveys"] }), qc.invalidateQueries({ queryKey: ["impact"] })]);
      onClose();
    } catch (e) {
      const problemsList = e instanceof ApiError && Array.isArray(e.details.problems) ? (e.details.problems as string[]) : null;
      setServerError(problemsList ? `Yanıtlar kabul edilmedi: ${problemsList.join("; ")}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal className="staff-response-modal staff-response-full" labelledBy="staff-entry-title" onClose={onClose}>
      <p className="eyebrow">PERSONEL GİRİŞİ</p>
      <h2 id="staff-entry-title">Yanıt Gir</h2>
      <p>Kâğıt formdaki veya yüz yüze alınan yanıtları aktarın. Yanıtlar anonim kaydedilir.</p>
      {serverError && <InlineNotice tone="error">{serverError}</InlineNotice>}
      <div className="staff-questions">
        {shown.map((q) => (
          <QuestionInput
            key={q.key}
            q={q}
            compact
            value={answers[q.key]}
            onChange={(v) => setAnswers((a) => ({ ...a, [q.key]: v }))}
            consent={!!consent[q.key]}
            onConsent={(v) => setConsent((c) => ({ ...c, [q.key]: v }))}
            error={errors[q.key]}
          />
        ))}
      </div>
      <div className="form-modal-actions">
        <button className="ghost-button" type="button" onClick={onClose}>
          Vazgeç
        </button>
        <button className="primary-button" type="button" onClick={submit} disabled={busy}>
          {busy && <LoadingMark />}
          Yanıtı Kaydet
        </button>
      </div>
    </Modal>
  );
}

const sumSpend = (r: SurveyResponse) => Object.values(r.spendKurus ?? {}).reduce((a, b) => a + b, 0) / 100;

export default function SurveyDetailPage() {
  const eventId = useEventId();
  const { surveyId } = useParams<{ surveyId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const survey = useSurvey(surveyId);
  const canManage = can("survey.manage");
  const [tab, setTab] = useState<"questions" | "responses">("questions");
  const responses = useResponses(surveyId, canManage && tab === "responses");
  const [modal, setModal] = useState<"share" | "entry" | null>(null);
  const [excluding, setExcluding] = useState<SurveyResponse | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  async function setStatus(action: "open" | "close") {
    setStatusBusy(true);
    try {
      await api(`/api/surveys/${surveyId}`, { method: "POST", body: { organizationId: orgId, action } });
      toast(action === "open" ? "Anket açıldı; paylaşım bağlantısı hazır." : "Anket kapatıldı.");
      await Promise.all([qc.invalidateQueries({ queryKey: keys.survey(surveyId) }), qc.invalidateQueries({ queryKey: ["surveys"] })]);
      if (action === "open") setModal("share");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setStatusBusy(false);
    }
  }

  if (survey.isPending) return <SkeletonRows rows={4} label="Anket yükleniyor" />;
  if (survey.isError) return <ErrorState error={survey.error} onRetry={() => survey.refetch()} />;
  const s = survey.data;

  return (
    <>
      <button className="back-button survey-back" type="button" onClick={() => router.push(`/etkinlikler/${eventId}/anketler`)}>
        <AppIcon name="arrow-left" />
        Anketlere Dön
      </button>
      <header className="survey-detail-header">
        <div>
          <StatusBadge status={SURVEY_STATUS_BADGE[s.status]} />
          <h2>{s.title}</h2>
          <p>
            {AUDIENCE_LABEL[s.audience] ?? s.audience} · v{s.version} · {s.questions.length} soru · {formatNumber(s.responses)} yanıt
            {s.targetResponses ? ` / hedef ${formatNumber(s.targetResponses)}` : ""}
          </p>
        </div>
        <div>
          {canManage && s.status === "DRAFT" && (
            <button className="primary-button" type="button" onClick={() => setStatus("open")} disabled={statusBusy}>
              {statusBusy && <LoadingMark />}
              Anketi Aç
            </button>
          )}
          {canManage && s.status === "OPEN" && (
            <>
              <button className="outline-button" type="button" onClick={() => setStatus("close")} disabled={statusBusy}>
                {statusBusy && <LoadingMark />}
                Anketi Kapat
              </button>
              {s.publicToken && (
                <button className="primary-button" type="button" onClick={() => setModal("share")}>
                  Bağlantıyı Paylaş
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {s.intro && <p className="survey-intro">{s.intro}</p>}

      <div className="survey-detail-tabs">
        <div className="text-tabs" role="tablist">
          <button className={tab === "questions" ? "active" : ""} type="button" role="tab" aria-selected={tab === "questions"} onClick={() => setTab("questions")}>
            Sorular
          </button>
          {canManage && (
            <button className={tab === "responses" ? "active" : ""} type="button" role="tab" aria-selected={tab === "responses"} onClick={() => setTab("responses")}>
              Yanıtlar
            </button>
          )}
        </div>
        {can("survey.collect") && s.acceptingResponses && (
          <button className="outline-button" type="button" onClick={() => setModal("entry")}>
            Yanıt Gir
          </button>
        )}
      </div>

      {tab === "questions" ? (
        <div className="question-preview-list">
          {s.questions.map((q, i) => (
            <article className="question-preview" key={q.key}>
              <span className="question-number">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <p>{QUESTION_TYPE_LABEL[q.type] ?? q.type}</p>
                <h3>{q.text}</h3>
                <div>
                  {q.required && <span>Zorunlu</span>}
                  {q.showIf && <span>Koşullu</span>}
                  {q.isSensitive && <span className="sensitive-tag">Hassas</span>}
                  {q.spendCategory && <span>Harcama</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : responses.isPending ? (
        <SkeletonRows rows={4} label="Yanıtlar yükleniyor" />
      ) : responses.isError ? (
        <ErrorState error={responses.error} onRetry={() => responses.refetch()} />
      ) : !responses.data.length ? (
        <EmptyState title="Henüz yanıt yok." />
      ) : (
        <div className="survey-response-table-wrap">
          <table className="survey-response-table">
            <thead>
              <tr>
                <th>Tarih</th>
                <th>Kanal</th>
                <th>Yerel/Ziyaretçi</th>
                <th>Grup</th>
                <th>Gün</th>
                <th>Harcama ₺</th>
                <th>Durum</th>
                <th><span className="visually-hidden">İşlem</span></th>
              </tr>
            </thead>
            <tbody>
              {[...responses.data].reverse().map((r) => (
                <tr key={r.id} className={r.isExcluded ? "excluded-row" : ""}>
                  <td>{formatDateTime(r.submittedAt)}</td>
                  <td>{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                  <td>{r.isLocalResident === null ? "—" : r.isLocalResident ? "Yerel" : "Ziyaretçi"}</td>
                  <td>{r.partySize ? `${r.partySize} kişi` : "—"}</td>
                  <td>{r.daysPresent ? `${r.daysPresent} gün` : "—"}</td>
                  <td>{Object.keys(r.spendKurus ?? {}).length ? formatTry(sumSpend(r)) : "—"}</td>
                  <td title={r.exclusionReason ?? undefined}>{r.isExcluded ? "Hariç" : "Dahil"}</td>
                  <td>
                    <button type="button" onClick={() => setExcluding(r)}>
                      {r.isExcluded ? "Dahil Et" : "Hariç Tut"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === "share" && s.publicToken && <ShareSurveyModal token={s.publicToken} onClose={() => setModal(null)} />}
      {modal === "entry" && <StaffResponseModal survey={s} onClose={() => setModal(null)} />}
      {excluding && <ExcludeResponseModal response={excluding} surveyId={surveyId} onClose={() => setExcluding(null)} />}
    </>
  );
}
