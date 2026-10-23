/**
 * The first question of the event's single survey link (one QR code for all measurement forms): in which role did the
 * respondent take part? Each answer option ("route") opens the questions of one or more audiences' surveys, like
 * section branching in a form builder — e.g. "Ziyaretçi" → the visitor survey and the local-residents survey.
 * A question that appears in several of those surveys (same key) is asked once and stored on each of them.
 *
 * Shared by the server (validation, storing) and the browser (the respondent's form, the organizer's editor).
 */
import { z } from "zod";
import { SURVEY_AUDIENCES, type SurveyAudienceValue } from "@/lib/domain/enums";

export const ROLE_QUESTION_TEXT = "Etkinliğe hangi rolle katıldınız?";
export const ROLE_QUESTION_HELP = "Yanıtınıza göre size uygun sorular gösterilecek.";

/** Respondent-facing labels of the default options (written for the respondent, not the organizer). */
export const RESPONDENT_ROLE_LABEL: Record<SurveyAudienceValue, string> = {
  ATTENDEE: "Ziyaretçi / katılımcı",
  EXHIBITOR: "Stant sahibi / katılımcı firma",
  SPONSOR: "Sponsor",
  LOCAL_BUSINESS: "Yerel esnaf / işletme",
  RESIDENT: "Bölge sakiniyim (etkinliğe katılmadım)",
  ORGANIZER: "Organizasyon ekibi / gönüllü",
  PUBLIC_AUTHORITY: "Kamu kurumu temsilcisi",
};

/** Order of the default options: the most common respondents first. */
export const ROLE_ORDER: readonly SurveyAudienceValue[] = ["ATTENDEE", "EXHIBITOR", "SPONSOR", "LOCAL_BUSINESS", "RESIDENT", "ORGANIZER", "PUBLIC_AUTHORITY"];
export const isAudience = (v: unknown): v is SurveyAudienceValue => (SURVEY_AUDIENCES as readonly unknown[]).includes(v);

export interface SurveyRoute { key: string; label: string; audiences: SurveyAudienceValue[] }

export const MAX_ROUTES = 12;
export const routeSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{1,40}$/, "key: a–z, 0–9, _"),
  label: z.string().trim().min(1, "Seçenek metni boş olamaz.").max(80, "Seçenek metni en fazla 80 karakter olabilir."),
  audiences: z.array(z.enum(SURVEY_AUDIENCES)).min(1, "Her seçenek en az bir anket açmalı.").max(SURVEY_AUDIENCES.length),
});
export const routesSchema = z.array(routeSchema).min(1, "En az bir seçenek gerekli.").max(MAX_ROUTES)
  .refine((rs) => new Set(rs.map((r) => r.key)).size === rs.length, "Seçenek anahtarları tekrar edemez.")
  .refine((rs) => rs.every((r) => new Set(r.audiences).size === r.audiences.length), "Bir seçenekte aynı anket iki kez seçilemez.");
export const roleQuestionTextSchema = z.string().trim().min(3, "Soru metni en az 3 karakter olmalı.").max(200);

/**
 * Default options from the audiences that have a survey: one per audience; the visitor option also opens the
 * local-residents survey (a visitor is often a resident of the area), and residents who did not attend keep their own option.
 */
export function defaultRoutes(present: readonly SurveyAudienceValue[]): SurveyRoute[] {
  const has = new Set(present);
  return ROLE_ORDER.filter((a) => has.has(a)).map((a) => ({
    key: a.toLowerCase(),
    label: RESPONDENT_ROLE_LABEL[a],
    audiences: a === "ATTENDEE" && has.has("RESIDENT") ? ["ATTENDEE", "RESIDENT"] : [a],
  }));
}

/** The routes in use: the organizer's saved ones (audiences without a survey dropped) or the defaults. */
export function effectiveRoutes(saved: readonly SurveyRoute[] | null | undefined, present: readonly SurveyAudienceValue[]): SurveyRoute[] {
  if (!saved?.length) return defaultRoutes(present);
  const has = new Set(present);
  return saved.map((r) => ({ ...r, audiences: r.audiences.filter((a) => has.has(a)) })).filter((r) => r.audiences.length > 0);
}

/** The questions a route shows: its audiences' questions in route order, a key shared by several surveys asked once. */
export function combinedQuestions<Q extends { key: string }>(sections: readonly { audience: string; questions: readonly Q[] }[], audiences: readonly string[]): Q[] {
  const seen = new Set<string>();
  const out: Q[] = [];
  for (const a of audiences) {
    for (const q of sections.find((s) => s.audience === a)?.questions ?? []) {
      if (seen.has(q.key)) continue;
      seen.add(q.key);
      out.push(q);
    }
  }
  return out;
}
