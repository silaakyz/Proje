"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import jsQR from "jsqr";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { keys, useCheckInStream, useEventDetail, useOrg } from "@/lib/api/hooks";
import { formatNumber, formatPercent, formatTime, ratio, ticketCode } from "@/lib/ui/format";
import { AppIcon, LoadingMark, Modal, useToast } from "@/components/eip/ui";
import { SessionGate } from "@/components/eip/shell";

type Result =
  | { tone: "success"; title: string; detail: string; attendeeId: string }
  | { tone: "warning" | "error"; title: string; detail?: string };

const RESULT_MS = 2600;
const SAME_CODE_MS = 4000;

function useScanner(onCode: (code: string) => void, active: boolean) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "on" | "denied" | "unavailable">("idle");
  const streamRef = useRef<MediaStream | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) return setState("unavailable");
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => undefined);
      }
      setState("on");
    } catch (e) {
      setState((e as Error)?.name === "NotAllowedError" ? "denied" : "unavailable");
    }
  }, []);

  useEffect(() => {
    if (state !== "on" || !active) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 180) return;
      last = t;
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !v.videoWidth) return;
      const w = 480;
      const h = Math.round((v.videoHeight / v.videoWidth) * w);
      const c = (canvasRef.current ??= document.createElement("canvas"));
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const code = jsQR(img.data, w, h, { inversionAttempts: "dontInvert" });
      if (code?.data) onCodeRef.current(code.data.trim());
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, active]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);
  return { videoRef, state, start, stop };
}

function GateCheckin() {
  const { eventId } = useParams<{ eventId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const event = useEventDetail(eventId);
  const allowed = can("checkin.perform");
  const live = useCheckInStream(eventId, allowed);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [undoing, setUndoing] = useState<string | null>(null);
  const lastScan = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const resultTimer = useRef<number | undefined>(undefined);

  const show = useCallback((r: Result) => {
    setResult(r);
    window.clearTimeout(resultTimer.current);
    resultTimer.current = window.setTimeout(() => setResult(null), RESULT_MS);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate?.(r.tone === "success" ? 60 : [80, 60, 80]);
  }, []);

  const submit = useCallback(
    async (token: string) => {
      setBusy(true);
      try {
        const r = await api<{ attendeeId: string; ticketType: string; checkedInAt: string }>(`/api/events/${eventId}/checkin`, {
          method: "POST",
          body: { organizationId: orgId, qrToken: token },
        });
        show({ tone: "success", title: "Giriş yapıldı", detail: `${r.ticketType} bilet · ${formatTime(r.checkedInAt)}`, attendeeId: r.attendeeId });
        void qc.invalidateQueries({ queryKey: keys.checkins(eventId) });
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.code === "ALREADY_CHECKED_IN")
          show({ tone: "warning", title: "Bu bilet zaten kullanıldı", detail: `İlk giriş: ${formatTime(String(e.details.checkedInAt ?? ""))}` });
        else if (e instanceof ApiError && e.code === "TICKET_CANCELLED") show({ tone: "error", title: "İptal edilmiş bilet" });
        else if (e instanceof ApiError && e.code === "UNKNOWN_TICKET") show({ tone: "error", title: "Bilet bulunamadı", detail: "Bu etkinliğe ait bir bilet değil." });
        else show({ tone: "error", title: "Giriş kaydedilemedi", detail: errorMessage(e) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [eventId, orgId, qc, show],
  );

  const onScan = useCallback(
    (code: string) => {
      const now = Date.now();
      if (busy || (code === lastScan.current.code && now - lastScan.current.at < SAME_CODE_MS)) return;
      lastScan.current = { code, at: now };
      void submit(code);
    },
    [busy, submit],
  );
  const scanner = useScanner(onScan, allowed && !manual);

  async function submitManual(e: FormEvent) {
    e.preventDefault();
    const code = manualCode.trim().toUpperCase();
    if (!/^EIP-[0-9A-F]{8}$/.test(code) && !/^[0-9A-F-]{36}$/i.test(code)) {
      toast("Bilet numarasını EIP-XXXXXXXX biçiminde girin.", "error");
      return;
    }
    const ok = await submit(/^EIP-/.test(code) ? code : code.toLowerCase());
    if (ok) {
      setManual(false);
      setManualCode("");
    }
  }

  async function undo(attendeeId: string) {
    setUndoing(attendeeId);
    try {
      await api(`/api/events/${eventId}/checkin/undo`, { method: "POST", body: { organizationId: orgId, attendeeId } });
      toast(`${ticketCode(attendeeId)} girişi geri alındı.`);
      setResult(null);
      void qc.invalidateQueries({ queryKey: keys.checkins(eventId) });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setUndoing(null);
    }
  }

  const s = live.data;
  const fiveMinAgo = Date.now() - 5 * 60_000;
  const lastFive = s?.recent.filter((r) => new Date(r.checkedInAt).getTime() >= fiveMinAgo).length ?? 0;
  const exitTo = can("attendee.read") ? `/etkinlikler/${eventId}/katilimcilar` : `/etkinlikler/${eventId}/genel`;

  if (!allowed) {
    return (
      <main className="checkin-mode">
        <div className="shell-loading">
          <p>Bu ekran için check-in yetkisi gerekir.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="checkin-mode">
      <header className="checkin-topbar">
        <div>
          <strong>{event.data?.title ?? "Etkinlik"}</strong>
          {event.data?.status === "live" ? (
            <span className="checkin-live">
              <i aria-hidden="true" />
              Canlı
            </span>
          ) : event.data ? (
            <span className="checkin-live checkin-not-live">{event.data.status === "completed" ? "Tamamlandı" : "Taslak"}</span>
          ) : null}
        </div>
        <button type="button" aria-label="Check-in modundan çık" onClick={() => router.push(exitTo)}>
          ×
        </button>
      </header>

      {!live.connected && (
        <div className="connection-banner" role="alert">
          Bağlantı koptu, yeniden bağlanılıyor…
        </div>
      )}
      {event.data?.status === "completed" && (
        <div className="connection-banner" role="alert">
          Etkinlik tamamlandı; yeni giriş kabul edilmez.
        </div>
      )}

      <div className="checkin-layout">
        <section className="scanner-panel">
          <div className="camera-view">
            <video ref={scanner.videoRef} className={scanner.state === "on" ? "camera-video on" : "camera-video"} muted playsInline aria-hidden="true" />
            <div className="scan-frame" aria-hidden="true">
              <i /><i /><i /><i />
            </div>
            {scanner.state !== "on" && (
              <div className="camera-start">
                {scanner.state === "denied" ? (
                  <p>Kamera izni verilmedi. Tarayıcı ayarlarından izin verin veya kodu elle girin.</p>
                ) : scanner.state === "unavailable" ? (
                  <p>Bu cihazda kamera kullanılamıyor. Kodu elle girin.</p>
                ) : (
                  <button className="primary-button" type="button" onClick={scanner.start} disabled={scanner.state === "starting"}>
                    {scanner.state === "starting" ? <LoadingMark /> : <AppIcon name="qr" />}
                    Kamerayı Başlat
                  </button>
                )}
              </div>
            )}
            {busy && !result && (
              <div className="checkin-result result-pending" role="status">
                <span className="result-icon" aria-hidden="true"><LoadingMark /></span>
                <div><strong>Kontrol ediliyor</strong></div>
              </div>
            )}
            {result && (
              <div className={`checkin-result result-${result.tone}`} role="status">
                <span className="result-icon" aria-hidden="true">
                  {result.tone === "success" ? <AppIcon name="check" /> : "!"}
                </span>
                <div>
                  <strong>{result.title}</strong>
                  {result.detail && <span>{result.detail}</span>}
                </div>
              </div>
            )}
          </div>
          <p>{scanner.state === "on" ? "QR kodu çerçeveye hizalayın" : "Kamerayı başlatın veya bilet numarasını elle girin"}</p>
          <div className="scanner-actions">
            <button className="manual-code-link" type="button" onClick={() => setManual(true)}>
              Kodu elle gir
            </button>
            {scanner.state === "on" && (
              <button className="manual-code-link" type="button" onClick={scanner.stop}>
                Kamerayı kapat
              </button>
            )}
          </div>
        </section>

        <aside className="checkin-side">
          <section className="checkin-counter">
            <p>
              <strong>{s ? formatNumber(s.checkedIn) : "—"}</strong>
              <span>/ {s ? formatNumber(s.total) : "—"}</span>
            </p>
            <div role="progressbar" aria-label="Toplam giriş" aria-valuenow={s ? Math.round(ratio(s.checkedIn, s.total)) : 0} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${s ? ratio(s.checkedIn, s.total) : 0}%` }} />
            </div>
            <small>
              {s && s.total > 0 ? `${formatPercent(s.checkedIn, s.total)} · ` : ""}Son 5 dakikada {formatNumber(lastFive)} giriş
            </small>
            {s && s.byTicketType.length > 1 && (
              <ul className="ticket-type-split">
                {s.byTicketType.map((t) => (
                  <li key={t.ticketType}>
                    <span>{t.ticketType}</span>
                    <b>{formatNumber(t.checkedIn)} / {formatNumber(t.total)}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="recent-checkins">
            <h2>Son girişler</h2>
            <div>
              {!s?.recent.length ? (
                <p className="muted-text">Henüz giriş yok.</p>
              ) : (
                s.recent.slice(0, 12).map((entry, index) => (
                  <div className="recent-entry" key={`${entry.attendeeId}-${entry.checkedInAt}`}>
                    <time>{formatTime(entry.checkedInAt)}</time>
                    <span>{entry.ticketType}</span>
                    <strong>{ticketCode(entry.attendeeId)}</strong>
                    {index === 0 && can("attendee.write") && (
                      <button className="ghost-button" type="button" disabled={undoing !== null} onClick={() => undo(entry.attendeeId)}>
                        {undoing === entry.attendeeId && <LoadingMark />}
                        Geri Al
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>

      {manual && (
        <Modal className="manual-code-modal" labelledBy="manual-code-title" onClose={() => setManual(false)}>
          <p className="eyebrow">ELLE GİRİŞ</p>
          <h2 id="manual-code-title">Bilet kodunu girin</h2>
          <form onSubmit={submitManual}>
            <label>
              <span>Bilet kodu</span>
              <input type="text" placeholder="EIP-7F3K2A9C" value={manualCode} onChange={(e) => setManualCode(e.target.value)} autoComplete="off" />
            </label>
            <div>
              <button className="ghost-button" type="button" onClick={() => setManual(false)}>
                Vazgeç
              </button>
              <button className="primary-button" type="submit" disabled={busy}>
                {busy && <LoadingMark />}
                Kodu Kontrol Et
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}

export default function CheckinPage() {
  return (
    <SessionGate>
      <GateCheckin />
    </SessionGate>
  );
}
