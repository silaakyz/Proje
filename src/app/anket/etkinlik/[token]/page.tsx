"use client";

/**
 * The event's single survey link — one QR code for all measurement forms (like section branching in a form builder):
 * the first question asks in which role the respondent took part; the chosen option decides which surveys' questions
 * follow (a question shared by several of them is asked once). Each survey stores its own response, so the impact and
 * KPI calculations read them exactly as before.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { PublicEventSurvey, SurveyQuestion } from "@/lib/api/types";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";
import { combinedQuestions } from "@/lib/surveys/roles";
import { buildPayload, QuestionInput, questionProblem, visibleQuestions, type Answers } from "@/components/eip/survey-form";

const ROLE_KEY = "__role";

function Message({ title, text }: { title: string; text: string }) {
  return (
    <main className="public-survey public-survey-message">
      <p className="public-wordmark">EIP</p>
      <div>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
    </main>
  );
}

export default function PublicEventSurveyPage() {
  const { token } = useParams<{ token: string }>();
  const survey = useQuery({
    queryKey: ["public-event-survey", token],
    queryFn: ({ signal }) => api<{ survey: PublicEventSurvey }>(`/api/public/event-surveys/${encodeURIComponent(token)}`, { signal }).then((r) => r.survey),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [answers, setAnswers] = useState<Answers>({});
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [closed, setClosed] = useState(false);

  const role = typeof answers[ROLE_KEY] === "string" ? (answers[ROLE_KEY] as string) : null;
  const route = survey.data?.routes.find((r) => r.key === role) ?? null;
  // the chosen option's surveys, in order; a question shared by several of them is asked once
  const routeQuestions = useMemo(() => (survey.data && route ? combinedQuestions(survey.data.sections, route.audiences) : []), [survey.data, route]);
  const firstSection = route ? survey.data?.sections.find((s) => s.audience === route.audiences[0]) ?? null : null;
  const roleLabel = survey.data?.roleQuestion.options.find((o) => o.value === role)?.label ?? null;
  const roleQuestion: SurveyQuestion | null = useMemo(() => (survey.data ? {
    key: ROLE_KEY, type: "SINGLE_CHOICE", text: survey.data.roleQuestion.text, helpText: survey.data.roleQuestion.helpText,
    required: true, isSensitive: false, options: survey.data.roleQuestion.options,
  } : null), [survey.data]);
  // role question first; the chosen role's questions after it (with their own show-if branching)
  const questions = useMemo(
    () => (roleQuestion ? [roleQuestion, ...(route ? visibleQuestions(routeQuestions, answers) : [])] : []),
    [roleQuestion, route, routeQuestions, answers],
  );
  const current = questions[Math.min(step, questions.length - 1)];
  const isLast = !!route && step >= questions.length - 1;

  useEffect(() => {
    if (step > questions.length - 1 && questions.length) setStep(questions.length - 1);
  }, [questions.length, step]);
  useEffect(() => {
    document.title = survey.data ? `${survey.data.eventTitle} · Anket` : "Anket · EIP";
  }, [survey.data]);

  if (survey.isPending) {
    return (
      <main className="public-survey public-survey-message" aria-busy="true">
        <p className="public-wordmark">EIP</p>
        <div><p>Anket yükleniyor…</p></div>
      </main>
    );
  }
  if (survey.isError) {
    const e = survey.error;
    if (e instanceof ApiError && e.code === "SURVEY_NOT_OPEN") return <Message title="Bu anket şu anda yanıt kabul etmiyor." text="Etkinlik düzenleyicisi anketleri kapattı veya henüz açmadı." />;
    if (e instanceof ApiError && e.status === 404) return <Message title="Anket bulunamadı." text="Bağlantıyı kontrol edin veya düzenleyiciden yeni bir bağlantı isteyin." />;
    return <Message title="Anket şu anda açılamıyor." text={errorMessage(e)} />;
  }
  if (closed) return <Message title="Bu anket artık yanıt kabul etmiyor." text="Etkinlik düzenleyicisi anketi kapattı." />;
  if (done) return <Message title="Teşekkür ederiz." text="Yanıtınız etkinliğin değerlendirilmesine katkı sağlayacak." />;

  const data = survey.data;
  const total = route ? questions.length : null;

  async function next() {
    if (!current) return;
    const problem = questionProblem(current, answers[current.key], consent);
    setError(problem);
    if (problem) return;
    if (!isLast) {
      setStep((i) => i + 1);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setBusy(true);
    setSubmitError("");
    try {
      await api(`/api/public/event-surveys/${encodeURIComponent(token)}/responses`, {
        method: "POST", body: { role, ...buildPayload(routeQuestions, answers, consent) },
      });
      setDone(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "SURVEY_NOT_OPEN") setClosed(true);
      else if (e instanceof ApiError && Array.isArray(e.details.problems)) setSubmitError("Bazı yanıtlar kabul edilmedi. Önceki sorulara dönüp kontrol edin.");
      else setSubmitError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="public-survey">
      <header>
        <p className="public-wordmark">EIP</p>
        <h1>{data.eventTitle}</h1>
        {roleLabel && step > 0 && <p className="public-survey-section">{roleLabel}</p>}
        {step === 1 && firstSection?.intro && <p>{firstSection.intro}</p>}
        <div className="public-progress">
          <span>{total ? `Soru ${Math.min(step + 1, total)} / ${total}` : "Başlangıç"}</span>
          <i>
            <i style={{ width: `${total ? ((step + 1) / total) * 100 : 4}%` }} />
          </i>
        </div>
      </header>

      <section className="public-question-wrap">
        {submitError && <InlineNotice tone="error">{submitError}</InlineNotice>}
        {current && (
          <QuestionInput
            key={current.key}
            q={current}
            value={answers[current.key]}
            onChange={(v) => {
              setError(null);
              // a different role leads to a different set of questions: earlier answers do not carry over
              if (current.key === ROLE_KEY) setAnswers((a) => (a[ROLE_KEY] === v ? a : { [ROLE_KEY]: v }));
              else setAnswers((a) => ({ ...a, [current.key]: v }));
            }}
            consent={!!consent[current.key]}
            onConsent={(v) => setConsent((c) => ({ ...c, [current.key]: v }))}
            error={error}
          />
        )}
        {current && !current.required && <p className="optional-note">Bu soru isteğe bağlı; boş bırakabilirsiniz.</p>}
      </section>

      <footer className="public-survey-footer">
        <button className="ghost-button" type="button" disabled={step === 0 || busy} onClick={() => { setError(null); setStep((i) => Math.max(0, i - 1)); }}>
          Geri
        </button>
        <button className="primary-button" type="button" onClick={next} disabled={busy}>
          {busy && <LoadingMark />}
          {isLast ? "Gönder" : "İleri"}
        </button>
      </footer>
      <p className="public-privacy">Yanıtlar anonimdir; ad, iletişim bilgisi veya bilet numarası kaydedilmez.</p>
    </main>
  );
}
