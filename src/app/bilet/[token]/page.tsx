"use client";

/** A ticket (/bilet/<qrToken>): the QR code shown at the entrance. Holding the link means holding the ticket. */
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import QRCode from "qrcode";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { formatDateRange, ticketCode } from "@/lib/ui/format";
import { InlineNotice } from "@/components/eip/ui";

interface PublicTicket { attendeeId: string; ticketType: string; isCheckedIn: boolean; cancelled: boolean; eventTitle: string; startDate: string | null; endDate: string | null; fullName: string | null }

export default function TicketPage() {
  const { token } = useParams<{ token: string }>();
  const t = useQuery({
    queryKey: ["public-ticket", token],
    queryFn: ({ signal }) => api<{ ticket: PublicTicket }>(`/api/public/tickets/${encodeURIComponent(token)}`, { signal }).then((r) => r.ticket),
    retry: false,
  });
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(token, { type: "svg", errorCorrectionLevel: "M", margin: 1 }).then(setSvg).catch(() => setSvg(""));
  }, [token]);
  useEffect(() => {
    document.title = t.data ? `${t.data.eventTitle} · Bilet` : "Bilet · EIP";
  }, [t.data]);

  return (
    <main className="public-survey public-registration">
      <p className="public-wordmark">EIP</p>
      {t.isPending ? <p>Yükleniyor…</p> : t.isError ? (
        <><h1>Bilet bulunamadı.</h1><p>{t.error instanceof ApiError && t.error.status === 404 ? "Bağlantıyı kontrol edin." : errorMessage(t.error)}</p></>
      ) : (
        <>
          <header>
            <h1>{t.data.eventTitle}</h1>
            <p>{formatDateRange(t.data.startDate, t.data.endDate)} · {t.data.ticketType} bileti{t.data.fullName ? ` · ${t.data.fullName}` : ""}</p>
          </header>
          <section className="public-ticket">
            {t.data.cancelled ? <InlineNotice tone="error">Bu bilet iptal edildi.</InlineNotice> : (
              <>
                {svg && <div className="ticket-qr public-ticket-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="Bilet QR kodu" />}
                <p className="public-ticket-code">{ticketCode(t.data.attendeeId)}</p>
                {t.data.isCheckedIn ? <InlineNotice tone="neutral">Bu biletle giriş yapıldı.</InlineNotice> : <p>Girişte bu kodu gösterin. Ekran parlaklığını artırmak okutmayı kolaylaştırır.</p>}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
