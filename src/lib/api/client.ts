/**
 * Thin fetch wrapper for the EIP Route Handlers (same origin, /api/*). The httpOnly session cookie is sent
 * automatically; identity never goes in the body. Errors come back as ApiError with the backend's
 * `code` (e.g. ALREADY_CHECKED_IN) and any extra fields (e.g. checkedInAt) in `details`.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

export function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => params.append(k, x));
    else params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function api<T>(path: string, { method = "GET", query, body, signal }: RequestOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      signal,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError(0, "Bağlantı kurulamadı.", "NETWORK");
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const { error, code, ...details } = data ?? {};
    const message = typeof error === "string" ? error : res.status === 400 ? "Geçersiz istek." : `İstek başarısız (${res.status}).`;
    throw new ApiError(res.status, message, typeof code === "string" ? code : undefined, details);
  }
  return data as T;
}

const BY_CODE: Record<string, string> = {
  INVALID_CREDENTIALS: "E-posta veya şifre hatalı.",
  EMAIL_IN_USE: "Bu e-posta adresiyle zaten bir hesap var. Giriş yapmayı deneyin.",
  RATE_LIMITED: "Çok fazla deneme yapıldı. Biraz bekleyip tekrar deneyin.",
  RATE_LIMIT_UNAVAILABLE: "Hizmet şu anda yanıt veremiyor. Birkaç saniye sonra tekrar deneyin.",
  INVALID_EVENT: "Etkinlik bilgileri geçersiz. Canlı veya tamamlanmış bir etkinlik için başlangıç tarihi girin.",
  ALREADY_MEMBER: "Bu hesap zaten bir kuruma bağlı.",
  EVENT_COMPLETED: "Etkinlik tamamlandı; bu işlem artık yapılamaz.",
  SURVEY_NOT_OPEN: "Bu anket şu anda yanıt kabul etmiyor.",
  INVALID_TRANSITION: "Anketin durumu bu işleme uygun değil. Sayfayı yenileyip tekrar deneyin.",
  NO_QUESTIONS: "Sorusu olmayan bir anket açılamaz.",
  NOT_CHECKED_IN: "Bu bilet için geri alınacak bir giriş yok.",
  AI_NOT_CONFIGURED: "Yapay zekâ hizmeti yapılandırılmamış. Sunucunun .env dosyasında GOOGLE_GENERATIVE_AI_API_KEY (Gemini) veya ANTHROPIC_API_KEY (Claude) tanımlanmalı.",
  ROLE_NOT_ALLOWED: "Rolünüz bu işleme izin vermiyor.",
  LAST_OWNER: "Kurumda en az bir kurum sahibi kalmalı. Önce başka bir üyeyi kurum sahibi yapın.",
  ALREADY_IN_ORGANIZATION: "Bu adres zaten kurumunuzun üyesi.",
  MEMBER_OF_OTHER_ORGANIZATION: "Bu adres başka bir kuruma bağlı; bir hesap yalnızca bir kuruma üye olabilir.",
  INVITATION_NOT_FOUND: "Davet bulunamadı. Bağlantıyı kontrol edin.",
  INVITATION_EXPIRED: "Davetin süresi dolmuş. Kurumdan yeni bir davet isteyin.",
  INVITATION_REVOKED: "Bu davet geri alınmış. Kurumdan yeni bir davet isteyin.",
  INVITATION_ACCEPTED: "Bu davet zaten kullanılmış.",
  INVITATION_EMAIL_MISMATCH: "Bu davet başka bir e-posta adresi için. Davet edilen adresle giriş yapın.",
  WRONG_PASSWORD: "Mevcut şifre hatalı.",
  SAME_PASSWORD: "Yeni şifre mevcut şifreden farklı olmalı.",
  DATES_UNORDERED: "Bitiş tarihi başlangıçtan önce olamaz.",
  IO_INVALID: "Girdi-çıktı hesabı yapılamadı: bölgesel değerleri ve δ'yı kontrol edin (bölge toplamı Türkiye toplamını aşamaz).",
  MENTION_EXISTS: "Bu bağlantı listede zaten var.",
  CSV_INVALID: "CSV dosyasında hatalı satırlar var; aşağıdaki listeyi düzeltip yeniden yükleyin.",
  AI_QUOTA: "Yapay zekâ kotası doldu (ücretsiz katmanın dakikalık/günlük sınırı). Biraz sonra tekrar deneyin.",
  AI_PROVIDER_ERROR: "Yapay zekâ hizmeti yanıt vermedi. Biraz sonra tekrar deneyin.",
  DATASET_XLS: "Eski Excel 97–2003 (.xls) dosyaları okunamıyor. Excel'de \"Farklı Kaydet → Excel Çalışma Kitabı (.xlsx)\" ile kaydedip yükleyin.",
  DATASET_TYPE: "Yalnızca Excel (.xlsx) ve CSV dosyaları okunabiliyor.",
  DATASET_TOO_LARGE: "Dosya en fazla 6 MB olabilir.",
  DATASET_NO_TABLE: "Dosyada okunabilir bir tablo bulunamadı: ilk satırlardan biri sütun adlarını, altındakiler veriyi içermeli.",
  DATASET_NOT_CONFIRMED: "Önce sütun eşleştirmesini onaylayın.",
  KPI_COMPUTED: "Bu KPI platform verisinden otomatik hesaplanıyor; elle değer girilemez.",
  NETWORK: "Bağlantı kurulamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.",
  SIGNUP_INVITE_ONLY: "Kayıt yalnızca davet edilen adreslerle yapılabilir. Davet e-postasındaki bağlantıyı kullanın veya kurum yöneticinize başvurun.",
  ORG_CREATION_CLOSED: "Yeni kurum oluşturma bu kurulumda kapalı. Bir kuruma katılmak için yöneticinizden davet isteyin.",
  EMAIL_DISABLED: "E-posta gönderimi bu kurulumda yapılandırılmamış. Şifrenizi sıfırlamak için kurum yöneticinize başvurun.",
  REGISTRATION_NOT_FOUND: "Bu kayıt formu bulunamadı veya kapatıldı.",
  REGISTRATION_NOT_OPEN: "Kayıtlar henüz açılmadı.",
  REGISTRATION_CLOSED: "Kayıtlar kapandı.",
  REGISTRATION_FULL: "Etkinlik kontenjanı doldu.",
  ALREADY_REGISTERED: "Bu e-posta adresiyle bu etkinliğe zaten kayıt yapılmış. Bilet bağlantınız kayıt e-postasında.",
  NOTICE_CHANGED: "Aydınlatma metni siz formu doldururken güncellendi. Sayfayı yenileyip yeni metni okuyarak tekrar deneyin.",
  RESET_LINK_INVALID: "Bu şifre sıfırlama bağlantısı geçersiz, kullanılmış veya süresi dolmuş. Yeni bir bağlantı isteyin.",
};

/** User-facing Turkish message for an API error (codes from docs/frontend-api.md). */
export function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Beklenmeyen bir hata oluştu. Sayfayı yenileyip tekrar deneyin.";
  if (e.code && BY_CODE[e.code]) return BY_CODE[e.code]!;
  if (e.status === 401) return "Oturumunuz sona erdi. Lütfen yeniden giriş yapın.";
  if (e.status === 403) return "Bu işlem için yetkiniz yok.";
  if (e.status === 404) return "Kayıt bulunamadı.";
  if (e.status === 400) return "Girilen bilgiler geçersiz. Alanları kontrol edin.";
  if (e.status >= 500) return "Sunucu isteği tamamlayamadı. Biraz sonra tekrar deneyin.";
  return e.message;
}
