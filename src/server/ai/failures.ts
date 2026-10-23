/**
 * Classifies a failed model call so that (1) the pipeline knows whether trying the fallback model can help and
 * (2) the organizer sees the actual reason instead of a generic "service unreachable". Messages are scrubbed of
 * anything that looks like a credential before they are stored or shown.
 */
import { APICallError, NoObjectGeneratedError, RetryError } from "ai";

export type AiFailureKind = "quota" | "overloaded" | "model_not_found" | "auth" | "truncated" | "invalid_request" | "network" | "other";

export interface AiFailure {
  kind: AiFailureKind;
  status?: number;
  /** Provider message, scrubbed and shortened. */
  message: string;
  /** Whether another model (separate quota, no thinking settings) may succeed. */
  retryWithFallback: boolean;
}

export const scrubSecrets = (s: string) => s
  .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[anahtar]")
  .replace(/sk-ant-[0-9A-Za-z_-]+/g, "[anahtar]")
  .replace(/([?&](key|api_key|apikey|token)=)[^&\s"']+/gi, "$1[anahtar]")
  .replace(/(x-goog-api-key|x-api-key|authorization)["':\s]+[^\s"',}]+/gi, "$1: [anahtar]");

function unwrap(err: unknown): unknown {
  if (RetryError.isInstance(err)) return err.lastError ?? err;
  const cause = (err as { cause?: unknown })?.cause;
  if (cause && APICallError.isInstance(cause)) return cause;
  return err;
}

export function classifyAiError(err: unknown): AiFailure {
  const e = unwrap(err);
  const status = APICallError.isInstance(e) ? e.statusCode : undefined;
  const body = APICallError.isInstance(e) && typeof e.responseBody === "string" ? e.responseBody.slice(0, 600) : "";
  const raw = `${e instanceof Error ? e.message : String(e)} ${body}`.replace(/\s+/g, " ").trim();
  const message = scrubSecrets(raw).slice(0, 400);
  const has = (re: RegExp) => re.test(raw);
  let kind: AiFailureKind;
  if (NoObjectGeneratedError.isInstance(err) || NoObjectGeneratedError.isInstance(e) || has(/finish ?reason.{0,20}length|MAX_TOKENS|JSON parsing failed|could not parse the response|No output generated/i)) kind = "truncated";
  else if (status === 429 || has(/\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i)) kind = "quota";
  else if (status === 401 || status === 403 || has(/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthori[sz]ed|invalid x-api-key/i)) kind = "auth";
  else if (status === 404 || has(/\bNOT_FOUND\b|is not found for API version|model.{0,40}not (found|supported)|not_found_error/i)) kind = "model_not_found";
  else if ((status !== undefined && status >= 500) || has(/\b50[0-4]\b|UNAVAILABLE|overloaded|INTERNAL|DEADLINE_EXCEEDED|high demand/i)) kind = "overloaded";
  else if (status === 400 || has(/INVALID_ARGUMENT|\b400\b|invalid_request_error/i)) kind = "invalid_request";
  else if (has(/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network|timed? ?out|aborted/i)) kind = "network";
  else kind = "other";
  return { kind, status, message, retryWithFallback: kind !== "auth" };
}

/** Turkish explanation for the organizer; the scrubbed provider message is shown under it as detail. */
export const AI_FAILURE_TEXT: Record<AiFailureKind, string> = {
  quota: "Yapay zekâ hizmetinin kullanım kotası doldu (ücretsiz Gemini katmanında dakikalık ve günlük sınırlar vardır). Biraz sonra tekrar deneyin ya da .env dosyasında başka bir model seçin.",
  overloaded: "Yapay zekâ modeli şu an yoğun ve isteği karşılayamadı. Birkaç dakika sonra tekrar deneyin.",
  model_not_found: "Ayarlı yapay zekâ modeli bu anahtarla kullanılamıyor. .env dosyasındaki AI_MODEL_EVENT_BUILDER değerini kontrol edin (boş bırakılırsa varsayılan model kullanılır).",
  auth: "Yapay zekâ anahtarı geçersiz ya da yetkisiz. .env dosyasındaki GOOGLE_GENERATIVE_AI_API_KEY (veya ANTHROPIC_API_KEY) değerini kontrol edip sunucuyu yeniden başlatın.",
  truncated: "Model yanıtı yarıda kesildi, plan tamamlanamadı. Tekrar deneyin; sorun sürerse metni kısaltın.",
  invalid_request: "Yapay zekâ hizmeti isteği kabul etmedi.",
  network: "Yapay zekâ hizmetine bağlanılamadı. İnternet bağlantısını ve güvenlik duvarını kontrol edin.",
  other: "Plan önerisi hazırlanırken beklenmeyen bir hata oluştu.",
};
