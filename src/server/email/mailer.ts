/**
 * Transactional e-mail through Brevo (the same account the e-mail statistics source uses).
 *
 *   BREVO_API_KEY   the account's API key (SMTP & API → API Keys)
 *   EMAIL_FROM      sender, e.g. "Kurum Adı <bilgi@kurum.gov.tr>" — the address must be a verified sender in Brevo
 *   APP_URL         public address of the app (https://…), used for every link in an e-mail. Required in production:
 *                   links are never built from the request's Host header (a forged Host would send people elsewhere).
 *
 * Without these the app keeps working without e-mail: invitations are shared as links, passwords are reset with
 * `npm run auth:set-password`. Errors never contain the key.
 */
import "server-only";

export interface Mail { to: string; subject: string; text: string; html: string }
export type MailFetch = (url: string, init: RequestInit) => Promise<Response>;

export class EmailError extends Error {}

export function parseSender(raw: string | undefined) {
  const v = raw?.trim();
  if (!v) return null;
  const m = v.match(/^(.*?)\s*<\s*([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)\s*>$/) ?? v.match(/^()([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/);
  if (!m) return null;
  return { name: m[1]!.replace(/^"|"$/g, "").trim() || undefined, email: m[2]! };
}

/** The app's public base URL for links in e-mails (no trailing slash); null when it cannot be trusted. */
export function appBaseUrl(request?: Request) {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured && /^https?:\/\/[^\s/]+$/.test(configured)) return configured;
  // Local development only: the request's own origin (http://localhost:3000, a LAN address or a tunnel).
  if (process.env.NODE_ENV !== "production" && request) return new URL(request.url).origin;
  return null;
}

export const emailConfigured = () => !!process.env.BREVO_API_KEY?.trim() && !!parseSender(process.env.EMAIL_FROM);
export const emailAvailable = (request?: Request) => emailConfigured() && !!appBaseUrl(request);

export async function sendMail(mail: Mail, fetchImpl: MailFetch = fetch) {
  const key = process.env.BREVO_API_KEY?.trim();
  const sender = parseSender(process.env.EMAIL_FROM);
  if (!key || !sender) throw new EmailError("E-posta gönderimi yapılandırılmamış (BREVO_API_KEY, EMAIL_FROM).");
  let res: Response;
  try {
    res = await fetchImpl("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": key, "content-type": "application/json", accept: "application/json" },
      // Brevo accepts one body type per request (htmlContent, textContent or templateId): the HTML one.
      body: JSON.stringify({ sender, to: [{ email: mail.to }], subject: mail.subject, htmlContent: mail.html }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new EmailError("E-posta servisine bağlanılamadı.");
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replaceAll(key, "[anahtar]").slice(0, 300);
    throw new EmailError(`E-posta gönderilemedi (Brevo ${res.status}${body ? `: ${body}` : ""}).`);
  }
}

// ------------------------------------------------------------------------------------------- templates

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, paragraphs: string[], action: { label: string; url: string }, footer: string) {
  const html = `<!doctype html><html lang="tr"><body style="margin:0;padding:24px;background:#fafafa;font-family:Arial,Helvetica,sans-serif;color:#121212">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e5e5e5;padding:32px">
<p style="margin:0 0 24px;font-family:Georgia,serif;font-size:20px">EIP</p>
<h1 style="margin:0 0 16px;font-size:20px;font-weight:600">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:22px">${esc(p)}</p>`).join("\n")}
<p style="margin:24px 0"><a href="${esc(action.url)}" style="display:inline-block;padding:12px 20px;background:#121212;color:#fff;text-decoration:none;font-size:15px">${esc(action.label)}</a></p>
<p style="margin:0 0 8px;font-size:13px;line-height:20px;color:#5c5c5c">Düğme çalışmazsa bu bağlantıyı tarayıcınıza yapıştırın:<br>${esc(action.url)}</p>
<p style="margin:16px 0 0;font-size:13px;line-height:20px;color:#5c5c5c">${esc(footer)}</p>
</div></body></html>`;
  const text = [title, "", ...paragraphs, "", `${action.label}: ${action.url}`, "", footer].join("\n");
  return { html, text };
}

const ROLE_TR: Record<string, string> = { owner: "kurum sahibi", admin: "yönetici", staff: "ekip üyesi" };

export function invitationMail(input: { to: string; organization: string; role: string; invitedBy: string | null; url: string; expiresAt: Date }): Mail {
  const until = new Intl.DateTimeFormat("tr-TR", { dateStyle: "long", timeZone: "Europe/Istanbul" }).format(input.expiresAt);
  const { html, text } = layout(
    `${input.organization} sizi EIP'e davet ediyor`,
    [
      `${input.invitedBy ? `${input.invitedBy} sizi` : "Sizi"} ${input.organization} çalışma alanına ${ROLE_TR[input.role] ?? input.role} olarak davet etti.`,
      "Daveti kabul etmek için aşağıdaki düğmeye tıklayın; hesabınız yoksa aynı e-posta adresiyle kayıt olmanız istenir.",
    ],
    { label: "Daveti Görüntüle", url: input.url },
    `Bu davet ${until} tarihine kadar geçerlidir. Beklemediğiniz bir davetse bu e-postayı yok sayabilirsiniz.`,
  );
  return { to: input.to, subject: `${input.organization} — EIP daveti`, html, text };
}

export function passwordResetMail(input: { to: string; url: string; minutes: number }): Mail {
  const { html, text } = layout(
    "Şifre sıfırlama",
    ["EIP hesabınız için bir şifre sıfırlama isteği aldık.", "Yeni şifrenizi belirlemek için aşağıdaki düğmeye tıklayın."],
    { label: "Yeni Şifre Belirle", url: input.url },
    `Bağlantı ${input.minutes} dakika geçerlidir ve bir kez kullanılabilir. Bu isteği siz yapmadıysanız bu e-postayı yok sayın; şifreniz değişmez.`,
  );
  return { to: input.to, subject: "EIP — şifre sıfırlama", html, text };
}

export function ticketMail(input: { to: string; name: string; event: string; organization: string; ticketType: string; startDate: string | null; url: string }): Mail {
  const when = input.startDate
    ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "long", timeZone: "Europe/Istanbul" }).format(new Date(`${input.startDate}T12:00:00+03:00`))
    : null;
  const { html, text } = layout(
    `${input.event} — biletiniz`,
    [
      `Merhaba ${input.name}, kaydınız alındı.`,
      `${input.ticketType} biletinizin QR kodu aşağıdaki bağlantıda. Etkinlik girişinde bu kodu telefonunuzdan gösterin${when ? ` (${when})` : ""}.`,
    ],
    { label: "Biletimi Göster", url: input.url },
    `Bu e-posta ${input.organization} tarafından etkinlik kaydınız için gönderildi. Bağlantıyı kimseyle paylaşmayın: bağlantıya sahip olan bileti kullanabilir.`,
  );
  return { to: input.to, subject: `${input.event} — biletiniz`, html, text };
}
