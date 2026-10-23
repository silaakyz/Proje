"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { PublicSurvey } from "@/lib/api/types";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";
import { buildPayload, QuestionInput, questionProblem, visibleQuestions, type Answers } from "@/components/eip/survey-form";

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

export default function PublicSurveyPage() {
  const { token } = useParams<{ token: string }>();
  const survey = useQuery({
    queryKey: ["public-survey", token],
    queryFn: ({ signal }) => api<{ survey: PublicSurvey }>(`/api/public/surveys/${encodeURIComponent(token)}`, { signal }).then((r) => r.survey),
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

  const questions = useMemo(() => (survey.data ? visibleQuestions(survey.data.questions, answers) : []), [survey.data, answers]);
  const current = questions[Math.min(step, questions.length - 1)];
  const isLast = step >= questions.length - 1;

  useEffect(() => {
    if (step > questions.length - 1 && questions.length) setStep(questions.length - 1);
  }, [questions.length, step]);

  useEffect(() => {
    document.title = survey.data ? `${survey.data.title} · EIP` : "Anket · EIP";
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
    if (e instanceof ApiError && e.code === "SURVEY_NOT_OPEN") return <Message title="Bu anket artık yanıt kabul etmiyor." text="Etkinlik düzenleyicisi anketi kapattı veya henüz açmadı." />;
    if (e instanceof ApiError && e.status === 404) return <Message title="Anket bulunamadı." text="Bağlantıyı kontrol edin veya düzenleyiciden yeni bir bağlantı isteyin." />;
    return <Message title="Anket şu anda açılamıyor." text={errorMessage(e)} />;
  }
  if (closed) return <Message title="Bu anket artık yanıt kabul etmiyor." text="Etkinlik düzenleyicisi anketi kapattı." />;
  if (done) return <Message title="Teşekkür ederiz." text="Yanıtınız etkinliğin değerlendirilmesine katkı sağlayacak." />;

  const s = survey.data;

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
      await api(`/api/public/surveys/${encodeURIComponent(token)}/responses`, { method: "POST", body: buildPayload(s.questions, answers, consent) });
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
        <h1>{s.title}</h1>
        {step === 0 && s.intro && <p>{s.intro}</p>}
        <div className="public-progress">
          <span>
            Soru {Math.min(step + 1, questions.length)} / {questions.length}
          </span>
          <i>
            <i style={{ width: `${questions.length ? ((step + 1) / questions.length) * 100 : 0}%` }} />
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
              setAnswers((a) => ({ ...a, [current.key]: v }));
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
