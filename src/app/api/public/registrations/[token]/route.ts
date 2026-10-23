/**
 * Public registration form (no session), /kayit/:token.
 * GET  → { form: { eventTitle, organization, startDate, endDate, city, ticketType, collectPhone, privacyNotice,
 *        noticeVersion, marketingConsentText, state } }; 404 unknown or disabled form.
 * POST { fullName, email, phone?, noticeVersion, noticeAccepted: true, marketingConsent? } → 201 { ticket: { qrToken,
 *        ticketType, emailed } }; 409 REGISTRATION_NOT_OPEN | REGISTRATION_CLOSED | REGISTRATION_FULL |
 *        ALREADY_REGISTERED | NOTICE_CHANGED; 400 invalid fields. Rate limited per IP and per (form, IP).
 */
import { registrationSubmitSchema } from "@/lib/registration/notice";
import { getPublicRegistrationForm, submitRegistration } from "@/server/registration/registration-service";
import { limitPublicSurveyRequest } from "@/server/surveys/public-rate-limit";
import { readJson } from "@/server/http-params";
import { toErrorResponse } from "@/server/http";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    const blocked = await limitPublicSurveyRequest(req, `reg:${token}`, "read");
    if (blocked) return blocked;
    return Response.json({ form: await getPublicRegistrationForm(token) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  try {
    const { token } = await params;
    const blocked = await limitPublicSurveyRequest(req, `reg:${token}`, "submit");
    if (blocked) return blocked;
    const input = registrationSubmitSchema.parse(await readJson(req));
    return Response.json({ ticket: await submitRegistration(req, token, input) }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (e) {
    return toErrorResponse(e);
  }
}
