"use client";
/**
 * Survey questions rendered from the stored definitions (same rules as the server validator,
 * src/lib/surveys/answers.ts): hidden questions (showIf) are never sent, visible required ones must be
 * answered, sensitive answers need explicit consent (never pre-ticked).
 */
import type { ReactNode } from "react";
import { PROVINCES } from "@/lib/geo/tr-provinces";
import type { SurveyQuestion } from "@/lib/api/types";
import { parseTrNumber } from "@/lib/ui/format";

export type Answers = Record<string, unknown>;

export const isVisible = (q: SurveyQuestion, answers: Answers) => !q.showIf || answers[q.showIf.key] === q.showIf.equals;

/** Questions currently shown, in order. */
export const visibleQuestions = (qs: SurveyQuestion[], answers: Answers) => qs.filter((q) => isVisible(q, answers));

const answered = (v: unknown) => !(v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0));

/** Problem text for one question, or null when its answer is acceptable. */
export function questionProblem(q: SurveyQuestion, v: unknown, consent: Record<string, boolean>): string | null {
  if (!answered(v)) return q.required ? "Bu soru zorunlu." : null;
  if (q.isSensitive && !consent[q.key]) return "Yanıtlamak için onay kutusunu işaretleyin.";
  switch (q.type) {
    case "NUMBER":
    case "PERCENT":
    case "CURRENCY_TRY":
      if (typeof v !== "number" || Number.isNaN(v)) return "Geçerli bir sayı girin.";
      if (q.type === "CURRENCY_TRY" && v < 0) return "Tutar negatif olamaz.";
      if (q.key === "q_party_size" && (v < 1 || v > 500 || !Number.isInteger(v))) return "1 ile 500 arasında bir tam sayı girin.";
      if (q.key === "q_days_present" && (v < 1 || v > 366 || !Number.isInteger(v))) return "1 ile 366 arasında bir tam sayı girin.";
      if (q.key === "q_nights_stayed" && (v < 0 || v > 366 || !Number.isInteger(v))) return "0 ile 366 arasında bir tam sayı girin.";
      return null;
    case "OPEN_TEXT":
    case "text":
      return typeof v === "string" && v.trim().length > 0 && v.length <= 2000 ? null : "En fazla 2.000 karakter.";
    default:
      return null;
  }
}

/** The payload for POST …/responses: only visible, answered questions. */
export function buildPayload(qs: SurveyQuestion[], answers: Answers, consent: Record<string, boolean>) {
  const out: Answers = {};
  let pass = { ...answers };
  // a parent answer can hide a child; iterate until stable
  for (let i = 0; i < 3; i++) {
    const vis = new Set(visibleQuestions(qs, pass).map((q) => q.key));
    pass = Object.fromEntries(Object.entries(pass).filter(([k]) => vis.has(k)));
  }
  for (const q of qs) {
    const v = pass[q.key];
    if (!answered(v)) continue;
    if (q.isSensitive && !consent[q.key]) continue;
    out[q.key] = typeof v === "string" ? v.trim() : v;
  }
  const sensitiveConsent = qs.some((q) => q.isSensitive && q.key in out);
  return { answers: out, sensitiveConsent };
}

export function QuestionInput({
  q, value, onChange, consent, onConsent, error, compact = false,
}: {
  q: SurveyQuestion; value: unknown; onChange: (v: unknown) => void; consent: boolean; onConsent: (v: boolean) => void; error?: string | null; compact?: boolean;
}) {
  const id = `q-${q.key}`;
  const disabled = q.isSensitive && !consent;
  const Wrapper = compact ? "div" : "fieldset";
  const legend = (
    <>
      {q.text}
      {q.required && <span className="required-mark" aria-label="zorunlu"> *</span>}
    </>
  );

  let control: ReactNode;
  switch (q.type) {
    case "LIKERT_5":
    case "rating":
      control = (
        <div className="scale-options five-scale">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n}>
              <input type="radio" name={id} checked={value === n} disabled={disabled} onChange={() => onChange(n)} />
              <span>{n}</span>
            </label>
          ))}
        </div>
      );
      break;
    case "NPS_0_10":
      control = (
        <div className="scale-options recommendation-scale">
          {Array.from({ length: 11 }, (_, n) => (
            <label key={n}>
              <input type="radio" name={id} checked={value === n} disabled={disabled} onChange={() => onChange(n)} />
              <span>{n}</span>
            </label>
          ))}
        </div>
      );
      break;
    case "YES_NO":
    case "boolean":
      control = (
        <div className="choice-list">
          {([[true, "Evet"], [false, "Hayır"]] as const).map(([v, l]) => (
            <label key={l}>
              <input type="radio" name={id} checked={value === v} disabled={disabled} onChange={() => onChange(v)} />
              <span>{l}</span>
            </label>
          ))}
        </div>
      );
      break;
    case "SINGLE_CHOICE":
      control = (
        <div className="choice-list">
          {(q.options ?? []).map((o) => (
            <label key={o.value}>
              <input type="radio" name={id} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    case "MULTI_CHOICE": {
      const list = Array.isArray(value) ? (value as string[]) : [];
      control = (
        <div className="choice-list">
          {(q.options ?? []).map((o) => (
            <label key={o.value}>
              <input
                type="checkbox"
                checked={list.includes(o.value)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
      break;
    }
    case "PROVINCE":
      control = (
        <select className="province-input" id={id} value={typeof value === "number" ? String(value) : ""} disabled={disabled} onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}>
          <option value="">İl seçin</option>
          {[...PROVINCES].sort((a, b) => a.name.localeCompare(b.name, "tr")).map((p) => (
            <option value={p.code} key={p.code}>{p.name}</option>
          ))}
          <option value="0">Yurt dışı</option>
        </select>
      );
      break;
    case "CURRENCY_TRY":
      control = (
        <div className="public-currency-field">
          <span>₺</span>
          <NumberField id={id} value={value} disabled={disabled} onChange={onChange} />
        </div>
      );
      break;
    case "NUMBER":
    case "PERCENT":
      control = (
        <div className="number-field-wrap">
          <NumberField id={id} value={value} disabled={disabled} onChange={onChange} />
          {q.type === "PERCENT" && <span>%</span>}
        </div>
      );
      break;
    default:
      control = (
        <textarea className="open-text-input" id={id} value={typeof value === "string" ? value : ""} maxLength={2000} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      );
  }

  return (
    <Wrapper className={`public-question${q.isSensitive ? " sensitive-question" : ""}${error ? " question-error" : ""}`}>
      {compact ? <p className="public-field-label">{legend}</p> : <legend>{legend}</legend>}
      {q.helpText && <p>{q.helpText}</p>}
      {q.type === "MULTI_CHOICE" && !q.helpText && <p>Birden fazla seçenek işaretleyebilirsiniz.</p>}
      {q.isSensitive && (
        <label className="consent-check">
          <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} />
          <span>Bu soruyu yanıtlamayı kabul ediyorum.</span>
        </label>
      )}
      {control}
      {error && <p className="field-message error-text" role="alert">{error}</p>}
    </Wrapper>
  );
}

function NumberField({ id, value, disabled, onChange }: { id: string; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      placeholder="0"
      disabled={disabled}
      defaultValue={typeof value === "number" ? String(value).replace(".", ",") : ""}
      onChange={(e) => {
        const n = parseTrNumber(e.target.value);
        onChange(n === null ? null : n);
      }}
    />
  );
}
