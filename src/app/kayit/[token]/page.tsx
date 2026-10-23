"use client";

/**
 * Public, KVKK-compliant event registration (/kayit/<token>): name, e-mail and (if asked) phone; the privacy notice
 * must be acknowledged; the explicit consent for e-mails after the event is separate, optional and unticked. On
 * success the ticket's QR code is shown and the ticket link is offered (and e-mailed when e-mail is configured).
 */
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import type { PublicRegistrationForm } from "@/lib/api/types";
import { formatDateRange } from "@/lib/ui/format";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";

const CLOSED_TEXT: Record<string, string> = {
  not_yet: "Kayıtlar henüz açılmadı.", closed: "Kayıtlar kapandı.", full: "Etkinlik kontenjanı doldu.", event_over: "Etkinlik sona erdi; kayıt alınmıyor.",
};

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="public-survey public-registration"><p className="public-wordmark">EIP</p>{children}</main>;
}

export default function RegistrationPage() {
  const { token } = useParams<{ token: string }>();
  const form = useQuery({
    queryKey: ["public-registration", token],
    queryFn: ({ signal }) => api<{ form: PublicRegistrationForm }>(`/api/public/registrations/${encodeURIComponent(token)}`, { signal }).then((r) => r.form),
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<{ qrToken: string; ticketType: string; emailed: boolean } | null>(null);
  const [svg, setSvg] = useState("");

  useEffect(() => {
    document.title = form.data ? `${form.data.eventTitle} · Kayıt` : "Kayıt · EIP";
  }, [form.data]);
  useEffect(() => {
    if (!ticket) return;
    QRCode.toString(ticket.qrToken, { type: "svg", errorCorrectionLevel: "M", margin: 1 }).then(setSvg).catch(() => setSvg(""));
  }, [ticket]);

  if (form.isPending) return <Shell><p>Yükleniyor…</p></Shell>;
  if (form.isError) {
    const e = form.error;
    return <Shell><h1>Kayıt formu bulunamadı.</h1><p>{e instanceof ApiError && e.status === 404 ? "Bağlantıyı kontrol edin veya düzenleyiciden yeni bir bağlantı isteyin." : errorMessage(e)}</p></Shell>;
  }
  const f = form.data;

  if (ticket) {
    const ticketUrl = `${window.location.origin}/bilet/${ticket.qrToken}`;
    return (
      <Shell>
        <header>
          <h1>Kaydınız alındı</h1>
          <p>{f.eventTitle} · {ticket.ticketType} bileti</p>
        </header>
        <section className="public-ticket">
          {svg && <div className="ticket-qr public-ticket-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="Bilet QR kodu" />}
          <p>Etkinlik girişinde bu QR kodu gösterin.</p>
          {ticket.emailed
            ? <InlineNotice tone="success">Bilet bağlantınızı e-posta adresinize de gönderdik.</InlineNotice>
            : <InlineNotice tone="warning">Biletinizi kaybetmemek için bu sayfanın ekran görüntüsünü alın veya bağlantıyı kaydedin.</InlineNotice>}
          <Link className="primary-button" href={`/bilet/${ticket.qrToken}`}>Bilet sayfasını aç</Link>
          <p className="public-privacy">Bilet bağlantısı: {ticketUrl}. Bağlantıyı kimseyle paylaşmayın.</p>
        </section>
      </Shell>
    );
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const fullName = String(d.get("fullName") || "").trim();
    const email = String(d.get("email") || "").trim();
    const phone = String(d.get("phone") || "").trim();
    const noticeAccepted = d.get("notice") === "on";
    const marketingConsent = d.get("consent") === "on";
    const errs: Record<string, string> = {};
    if (fullName.length < 2) errs.fullName = "Adınızı ve soyadınızı yazın.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errs.email = "Geçerli bir e-posta adresi girin.";
    if (phone && !/^[+0-9 ()-]{7,25}$/.test(phone)) errs.phone = "Geçerli bir telefon numarası girin.";
    if (!noticeAccepted) errs.notice = "Kayıt için aydınlatma metnini okuduğunuzu onaylamanız gerekir.";
    setErrors(errs);
    setFormError("");
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api<{ ticket: { qrToken: string; ticketType: string; emailed: boolean } }>(`/api/public/registrations/${encodeURIComponent(token)}`, {
        method: "POST", body: { fullName, email, phone: f.collectPhone && phone ? phone : null, noticeVersion: f.noticeVersion, noticeAccepted: true, marketingConsent },
      });
      setTicket(r.ticket);
      window.scrollTo({ top: 0 });
    } catch (err) {
      setFormError(errorMessage(err));
      if (err instanceof ApiError && err.code === "NOTICE_CHANGED") void form.refetch();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <header>
        <h1>{f.eventTitle}</h1>
        <p>{formatDateRange(f.startDate, f.endDate)}{f.city ? ` · ${f.city}` : ""} · {f.organization}</p>
      </header>
      {f.state !== "open" ? (
        <InlineNotice tone="warning">{CLOSED_TEXT[f.state] ?? "Kayıt alınmıyor."}</InlineNotice>
      ) : (
        <form className="public-registration-form" onSubmit={submit} noValidate>
          {formError && <InlineNotice tone="error">{formError}</InlineNotice>}
          <label>
            <span>Ad soyad</span>
            <input name="fullName" autoComplete="name" maxLength={200} aria-invalid={!!errors.fullName} />
            {errors.fullName && <small className="error-text">{errors.fullName}</small>}
          </label>
          <label>
            <span>E-posta</span>
            <input name="email" type="email" autoComplete="email" maxLength={320} aria-invalid={!!errors.email} />
            {errors.email && <small className="error-text">{errors.email}</small>}
          </label>
          {f.collectPhone && (
            <label>
              <span>Telefon (isteğe bağlı)</span>
              <input name="phone" type="tel" autoComplete="tel" maxLength={25} aria-invalid={!!errors.phone} />
              {errors.phone && <small className="error-text">{errors.phone}</small>}
            </label>
          )}
          <div className="public-notice" tabIndex={0} aria-label="Aydınlatma metni">
            {f.privacyNotice.split("\n").map((line, i) => (line.trim() ? <p key={i}>{line}</p> : null))}
          </div>
          <label className="public-check">
            <input type="checkbox" name="notice" aria-invalid={!!errors.notice} />
            <span>Kişisel verilerimin işlenmesine ilişkin aydınlatma metnini okudum ve anladım. <em>(zorunlu)</em></span>
          </label>
          {errors.notice && <small className="error-text">{errors.notice}</small>}
          {f.marketingConsentText && (
            <label className="public-check">
              <input type="checkbox" name="consent" />
              <span>{f.marketingConsentText} <em>(isteğe bağlı)</em></span>
            </label>
          )}
          <button className="primary-button" type="submit" disabled={busy}>{busy && <LoadingMark />}Kayıt Ol</button>
          <p className="public-privacy">Yalnızca kayıt ve giriş için gereken bilgiler istenir. {f.ticketType} bileti oluşturulur.</p>
        </form>
      )}
    </Shell>
  );
}
