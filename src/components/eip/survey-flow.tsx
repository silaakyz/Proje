"use client";

/**
 * Anketler: the event's single survey flow — one QR code for all measurement forms. Question 1 asks the respondent's
 * role; each option opens one or more surveys (e.g. "Ziyaretçi" → visitor + local-residents survey). The organizer sees
 * and edits that first question here, opens every draft at once and downloads the QR code for print.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useOrg, useSurveyLink } from "@/lib/api/hooks";
import type { EventSurveyLink, SurveyRouteInfo } from "@/lib/api/types";
import { AUDIENCE_LABEL, SURVEY_STATUS_BADGE } from "@/lib/ui/labels";
import { InlineNotice, LoadingMark, SkeletonRows, StatusBadge, useCopy, useToast } from "@/components/eip/ui";

const surveyLabel = (link: EventSurveyLink, audience: string) => link.surveys.find((s) => s.audience === audience)?.title ?? AUDIENCE_LABEL[audience] ?? audience;

function FlowEditor({ eventId, link, onDone }: { eventId: string; link: EventSurveyLink; onDone: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [question, setQuestion] = useState(link.roleQuestion);
  const [routes, setRoutes] = useState<SurveyRouteInfo[]>(link.routes.map((r) => ({ ...r, audiences: [...r.audiences] })));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const setRoute = (i: number, patch: Partial<SurveyRouteInfo>) => setRoutes((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const toggle = (i: number, audience: string) => setRoutes((rs) => rs.map((r, j) => (j !== i ? r
    : { ...r, audiences: r.audiences.includes(audience) ? r.audiences.filter((a) => a !== audience) : [...r.audiences, audience] })));

  async function save(body: { roleQuestion: string | null; routes: SurveyRouteInfo[] | null }) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/events/${eventId}/survey-link`, { method: "PUT", body: { organizationId: orgId, ...body } });
      await qc.invalidateQueries({ queryKey: keys.surveys(eventId) });
      toast("İlk soru kaydedildi.");
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  function submit() {
    if (question.trim().length < 3) return setError("Soru metni en az 3 karakter olmalı.");
    if (!routes.length) return setError("En az bir seçenek gerekli.");
    const empty = routes.findIndex((r) => !r.label.trim());
    if (empty >= 0) return setError(`${empty + 1}. seçeneğin metni boş.`);
    const none = routes.findIndex((r) => !r.audiences.length);
    if (none >= 0) return setError(`"${routes[none]!.label}" seçeneği hiçbir anketi açmıyor; en az birini işaretleyin.`);
    void save({ roleQuestion: question.trim(), routes: routes.map((r) => ({ ...r, label: r.label.trim() })) });
  }

  return (
    <div className="flow-editor">
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <label className="flow-editor-question">
        <span>1. soru</span>
        <input value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={200} />
      </label>
      <p className="muted-text">Her seçenek için, o cevabı verene hangi anketlerin sorularının geleceğini işaretleyin.</p>
      <ol className="flow-editor-routes">
        {routes.map((r, i) => (
          <li key={r.key}>
            <div className="flow-editor-route-head">
              <input aria-label={`${i + 1}. seçenek`} value={r.label} onChange={(e) => setRoute(i, { label: e.target.value })} maxLength={80} />
              <button className="text-button danger" type="button" onClick={() => setRoutes((rs) => rs.filter((_, j) => j !== i))}>Kaldır</button>
            </div>
            <div className="flow-editor-surveys" role="group" aria-label={`"${r.label}" seçeneğinin açtığı anketler`}>
              {link.surveys.map((s) => (
                <label key={s.audience} className="flow-check">
                  <input type="checkbox" checked={r.audiences.includes(s.audience)} onChange={() => toggle(i, s.audience)} />
                  <span>{s.title}</span>
                </label>
              ))}
            </div>
          </li>
        ))}
      </ol>
      <div className="data-source-actions">
        <button className="outline-button" type="button" disabled={routes.length >= 12}
          onClick={() => setRoutes((rs) => [...rs, { key: `r_${Date.now().toString(36)}`, label: "", audiences: [] }])}>
          Seçenek ekle
        </button>
        {link.customized && (
          <button className="text-button" type="button" disabled={busy} onClick={() => save({ roleQuestion: null, routes: null })}>Varsayılana dön</button>
        )}
        <span className="flow-editor-spacer" />
        <button className="ghost-button" type="button" onClick={onDone} disabled={busy}>Vazgeç</button>
        <button className="primary-button" type="button" onClick={submit} disabled={busy}>{busy && <LoadingMark />}Kaydet</button>
      </div>
    </div>
  );
}

export function SurveyFlowCard({ eventId }: { eventId: string }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const link = useSurveyLink(eventId, true);
  const { copied, copy } = useCopy();
  const [svg, setSvg] = useState("");
  const [editing, setEditing] = useState(false);
  const [opening, setOpening] = useState(false);
  const token = link.data?.token;
  const url = token ? (typeof window === "undefined" ? `/anket/etkinlik/${token}` : `${window.location.origin}/anket/etkinlik/${token}`) : "";

  useEffect(() => {
    if (!url) return;
    QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 }).then(setSvg).catch(() => setSvg(""));
  }, [url]);

  if (link.isPending) return <SkeletonRows rows={2} label="Ortak anket akışı yükleniyor" />;
  if (link.isError) {
    return (
      <InlineNotice tone="error">
        Ortak anket bağlantısı yüklenemedi: {errorMessage(link.error)}. Veritabanı güncel değilse <code>npm run drizzle:migrate</code> çalıştırıp
        sunucuyu yeniden başlatın.
      </InlineNotice>
    );
  }
  const l = link.data;
  if (!l.surveys.length) return null;
  const drafts = l.surveys.filter((s) => !s.accepting && s.status === "DRAFT");
  const anyOpen = l.surveys.some((s) => s.accepting);

  async function openAll() {
    setOpening(true);
    try {
      const r = await api<{ opened: string[]; skipped: { audience: string; reason: string }[] }>(
        `/api/events/${eventId}/survey-link`, { method: "POST", body: { organizationId: orgId, action: "open_all" } });
      await qc.invalidateQueries({ queryKey: keys.surveys(eventId) });
      toast(r.opened.length ? `${r.opened.length} anket yayına alındı; QR kod artık bu anketleri de açıyor.` : "Yayına alınacak taslak anket yok.");
      for (const s of r.skipped) toast(`${AUDIENCE_LABEL[s.audience] ?? s.audience}: ${s.reason}`, "error");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setOpening(false);
    }
  }
  function downloadQr() {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "anket-qr.svg";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="shared-survey-link" aria-labelledby="survey-flow-title">
      <div className="shared-survey-link-text">
        <p className="eyebrow">TEK QR KOD · ORTAK ANKET AKIŞI</p>
        <h3 id="survey-flow-title">Tüm ölçüm formları tek bağlantıdan</h3>
        {editing ? (
          <FlowEditor eventId={eventId} link={l} onDone={() => setEditing(false)} />
        ) : (
          <>
            <ol className="survey-flow">
              <li>
                <span className="survey-flow-num">1</span>
                <div>
                  <strong>{l.roleQuestion}</strong>
                  <ul className="survey-flow-routes">
                    {l.routes.map((r) => (
                      <li key={r.key}>
                        <span className="survey-flow-option">{r.label}</span>
                        <span className="survey-flow-arrow" aria-hidden="true">→</span>
                        <span className="survey-flow-targets">
                          {r.audiences.map((a, i) => {
                            const s = l.surveys.find((x) => x.audience === a);
                            return (
                              <span key={a}>
                                {i > 0 && " + "}
                                {surveyLabel(l, a)}
                                {s && !s.accepting && <span className="survey-flow-state"> ({SURVEY_STATUS_BADGE[s.status].toLocaleLowerCase("tr-TR")})</span>}
                              </span>
                            );
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
              <li>
                <span className="survey-flow-num">2</span>
                <div><span className="muted-text">Seçilen rolün anket soruları. Birden fazla ankette ortak olan soru bir kez sorulur, yanıt her ankete kaydedilir.</span></div>
              </li>
            </ol>
            {!anyOpen && (
              <InlineNotice tone="warning">
                Anketler henüz yayında değil: bağlantı açıldığında &ldquo;henüz açılmadı&rdquo; der. QR kodu şimdiden basabilirsiniz; anketleri yayına aldığınızda aynı kod çalışır.
              </InlineNotice>
            )}
            <div className="data-source-actions">
              <button className="outline-button" type="button" onClick={() => setEditing(true)}>İlk soruyu düzenle</button>
              {drafts.length > 0 && (
                <button className="primary-button" type="button" onClick={openAll} disabled={opening}>
                  {opening && <LoadingMark />}Tümünü yayına al ({drafts.length} taslak)
                </button>
              )}
            </div>
          </>
        )}
        <div className="shared-survey-url">
          <input aria-label="Ortak anket bağlantısı" type="text" readOnly value={url} onFocus={(e) => e.target.select()} />
          <button className="outline-button" type="button" onClick={() => copy(url)}>{copied ? "Kopyalandı" : "Kopyala"}</button>
          <a className="text-link" href={url} target="_blank" rel="noreferrer">Aç</a>
        </div>
      </div>
      <div className="survey-flow-qr">
        {svg && <div className="ticket-qr share-qr" dangerouslySetInnerHTML={{ __html: svg }} aria-label="Ortak anket QR kodu" role="img" />}
        {svg && <button className="text-button" type="button" onClick={downloadQr}>QR kodu indir (SVG)</button>}
        <StatusBadge status={anyOpen ? "AÇIK" : "TASLAK"} />
      </div>
    </section>
  );
}
