"use client";

/**
 * Katılımcılar: the event's public, KVKK-compliant registration form — settings (privacy notice, optional consent,
 * capacity, retention), the link and QR code to share, and the people who registered (personal data visible to
 * owner/admin only; erasable one by one, deleted automatically after the retention period).
 */
import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useOrg, useRegistrationForm, useRegistrations } from "@/lib/api/hooks";
import type { Registration, RegistrationForm } from "@/lib/api/types";
import { formatDateTime, formatNumber } from "@/lib/ui/format";
import { InlineNotice, LoadingMark, Modal, SkeletonRows, StatusBadge, useCopy, useToast } from "@/components/eip/ui";

const STATE_LABEL: Record<RegistrationForm["state"], string> = {
  open: "AÇIK", not_enabled: "KAPALI", not_yet: "HENÜZ AÇILMADI", closed: "KAPANDI", full: "DOLU", event_over: "ETKİNLİK BİTTİ",
};
const RETENTION = [30, 60, 90, 180, 365];
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);

function SettingsForm({ eventId, form, onDone }: { eventId: string; form: RegistrationForm; onDone: () => void }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({
    enabled: form.enabled, ticketType: form.ticketType, capacity: form.capacity ? String(form.capacity) : "",
    opensAt: toLocalInput(form.opensAt), closesAt: toLocalInput(form.closesAt), collectPhone: form.collectPhone,
    privacyNotice: form.privacyNotice, askConsent: form.marketingConsentText !== null,
    marketingConsentText: form.marketingConsentText ?? form.defaults.marketingConsentText, retentionDays: form.retentionDays,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof v>(k: K, x: (typeof v)[K]) => setV((o) => ({ ...o, [k]: x }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    const capacity = v.capacity.trim() ? Number(v.capacity) : null;
    if (capacity !== null && (!Number.isInteger(capacity) || capacity < 1)) return setError("Kontenjan pozitif bir tam sayı olmalı (boş = sınırsız).");
    if (v.privacyNotice.trim().length < 50) return setError("Aydınlatma metni en az 50 karakter olmalı.");
    if (v.askConsent && v.marketingConsentText.trim().length < 10) return setError("Açık rıza metni en az 10 karakter olmalı.");
    setBusy(true);
    try {
      await api(`/api/events/${eventId}/registration-form`, {
        method: "PUT",
        body: {
          organizationId: orgId, enabled: v.enabled, ticketType: v.ticketType.trim() || "Genel", capacity,
          opensAt: fromLocalInput(v.opensAt), closesAt: fromLocalInput(v.closesAt), collectPhone: v.collectPhone,
          privacyNotice: v.privacyNotice, marketingConsentText: v.askConsent ? v.marketingConsentText : null, retentionDays: v.retentionDays,
        },
      });
      await qc.invalidateQueries({ queryKey: ["registration-form", eventId] });
      toast("Kayıt formu kaydedildi.");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="registration-settings" onSubmit={submit}>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <label className="registration-check"><input type="checkbox" checked={v.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Kayıt formu açık</label>
      <div className="registration-grid">
        <label><span>Bilet türü</span><input value={v.ticketType} maxLength={60} onChange={(e) => set("ticketType", e.target.value)} /></label>
        <label><span>Kontenjan (boş = sınırsız)</span><input inputMode="numeric" value={v.capacity} onChange={(e) => set("capacity", e.target.value)} /></label>
        <label><span>Kayıt açılışı (isteğe bağlı)</span><input type="datetime-local" value={v.opensAt} onChange={(e) => set("opensAt", e.target.value)} /></label>
        <label><span>Kayıt kapanışı (isteğe bağlı)</span><input type="datetime-local" value={v.closesAt} onChange={(e) => set("closesAt", e.target.value)} /></label>
        <label>
          <span>Kişisel verilerin saklama süresi</span>
          <select value={v.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value))}>
            {RETENTION.map((d) => <option key={d} value={d}>Etkinlik bitiminden {d} gün sonra silinsin</option>)}
          </select>
        </label>
      </div>
      <label className="registration-check"><input type="checkbox" checked={v.collectPhone} onChange={(e) => set("collectPhone", e.target.checked)} /> Telefon numarası da sorulsun (isteğe bağlı alan)</label>
      <label className="registration-notice">
        <span>Aydınlatma metni (KVKK m. 10)</span>
        <textarea rows={10} value={v.privacyNotice} onChange={(e) => set("privacyNotice", e.target.value)} />
      </label>
      <div className="data-source-actions">
        <button className="text-button" type="button" onClick={() => set("privacyNotice", form.defaults.privacyNotice)}>Şablon metni yükle</button>
      </div>
      <label className="registration-check"><input type="checkbox" checked={v.askConsent} onChange={(e) => set("askConsent", e.target.checked)} /> Etkinlik sonrası e-posta için açık rıza iste (isteğe bağlı, işaretsiz gösterilir)</label>
      {v.askConsent && (
        <label className="registration-notice"><span>Açık rıza metni</span><textarea rows={3} value={v.marketingConsentText} onChange={(e) => set("marketingConsentText", e.target.value)} /></label>
      )}
      <InlineNotice tone="warning">
        Şablon metin bir başlangıç noktasıdır; yayınlamadan önce kurumunuzun hukuk birimine onaylatın. Metni değiştirmek sürüm numarasını
        artırır; her kayıt, onayladığı sürümle birlikte saklanır.
      </InlineNotice>
      <div className="data-source-actions">
        <button className="ghost-button" type="button" onClick={onDone} disabled={busy}>Vazgeç</button>
        <button className="primary-button" type="submit" disabled={busy}>{busy && <LoadingMark />}Kaydet</button>
      </div>
    </form>
  );
}

function downloadCsv(rows: Registration[], title: string) {
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const lines = [
    ["ad_soyad", "e_posta", "telefon", "bilet", "giris", "aydinlatma_surumu", "aydinlatma_onay", "eposta_izni", "eposta_izni_tarih", "kayit"].join(";"),
    ...rows.map((r) => [q(r.fullName), q(r.email), q(r.phone ?? ""), q(r.ticketType), r.cancelledAt ? "iptal" : r.isCheckedIn ? "evet" : "hayir",
      r.noticeVersion, r.noticeAcceptedAt, r.marketingConsent ? "evet" : "hayir", r.marketingConsentAt ?? "", r.createdAt].join(";")),
  ];
  const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) || "kayitlar"}-kayitlar.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function RegistrationSection({ eventId, eventTitle, canWrite }: { eventId: string; eventTitle: string; canWrite: boolean }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const form = useRegistrationForm(eventId, canWrite);
  const regs = useRegistrations(eventId, true);
  const { copied, copy } = useCopy();
  const [svg, setSvg] = useState("");
  const [editing, setEditing] = useState(false);
  const [erase, setErase] = useState<Registration | null>(null);
  const [busy, setBusy] = useState(false);
  const url = form.data ? `${typeof window === "undefined" ? "" : window.location.origin}/kayit/${form.data.token}` : "";

  useEffect(() => {
    if (!url) return;
    QRCode.toString(url, { type: "svg", errorCorrectionLevel: "M", margin: 1 }).then(setSvg).catch(() => setSvg(""));
  }, [url]);

  async function eraseOne() {
    if (!erase) return;
    setBusy(true);
    try {
      await api(`/api/registrations/${erase.id}`, { method: "DELETE", query: { organizationId: orgId } });
      await Promise.all([qc.invalidateQueries({ queryKey: ["registrations", eventId] }), qc.invalidateQueries({ queryKey: ["registration-form", eventId] }),
        qc.invalidateQueries({ queryKey: keys.attendees(eventId) })]);
      toast("Kişisel veriler silindi; bilet anonim olarak kaldı.");
      setErase(null);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const f = form.data;
  return (
    <section className="registration-section" aria-labelledby="registration-title">
      <div className="registration-head">
        <div>
          <p className="eyebrow">KVKK UYUMLU KAYIT FORMU</p>
          <h3 id="registration-title">Herkese açık kayıt</h3>
          <p className="muted-text">
            Katılımcılar bağlantı veya QR kod ile kendileri kayıt olur; bilet QR kodları ekranda gösterilir ve e-posta ayarlıysa gönderilir.
            Ad, e-posta ve (açarsanız) telefon dışında veri istenmez.
          </p>
        </div>
        {f && <StatusBadge status={STATE_LABEL[f.state]} />}
      </div>

      {canWrite && form.isPending && <SkeletonRows rows={2} label="Kayıt formu yükleniyor" />}
      {canWrite && form.isError && <InlineNotice tone="error">{errorMessage(form.error)}</InlineNotice>}
      {f && (editing ? (
        <SettingsForm eventId={eventId} form={f} onDone={() => setEditing(false)} />
      ) : (
        <div className="registration-body">
          <div className="registration-info">
            <p>
              <strong>{formatNumber(f.registered)}</strong> kayıt{f.capacity ? ` / ${formatNumber(f.capacity)} kontenjan` : ""} · {f.ticketType} bileti ·
              aydınlatma metni sürüm {f.noticeVersion} · kişisel veriler etkinlik bitiminden {f.retentionDays} gün sonra silinir
            </p>
            {f.enabled ? (
              <div className="shared-survey-url">
                <input aria-label="Kayıt bağlantısı" readOnly value={url} onFocus={(e) => e.target.select()} />
                <button className="outline-button" type="button" onClick={() => copy(url)}>{copied ? "Kopyalandı" : "Kopyala"}</button>
                <a className="text-link" href={url} target="_blank" rel="noreferrer">Aç</a>
              </div>
            ) : (
              <InlineNotice tone="neutral">Kayıt formu kapalı. Ayarlardan aydınlatma metnini gözden geçirip formu açın.</InlineNotice>
            )}
            <div className="data-source-actions">
              <button className="outline-button" type="button" onClick={() => setEditing(true)}>Ayarlar ve aydınlatma metni</button>
            </div>
          </div>
          {f.enabled && svg && <div className="ticket-qr share-qr" dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="Kayıt formu QR kodu" />}
        </div>
      ))}

      {regs.data && regs.data.length > 0 && (
        <>
          <div className="registration-list-head">
            <p className="eyebrow">KAYITLAR ({formatNumber(regs.data.length)})</p>
            <button className="text-button" type="button" onClick={() => downloadCsv(regs.data, eventTitle)}>CSV indir</button>
          </div>
          <div className="tickets-table-wrap">
            <table className="tickets-table registration-table">
              <thead><tr><th>Ad soyad</th><th>E-posta</th><th>Telefon</th><th>Bilet</th><th>Aydınlatma</th><th>E-posta izni</th><th>Kayıt</th><th aria-label="İşlem" /></tr></thead>
              <tbody>
                {regs.data.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Ad soyad">{r.fullName}</td>
                    <td data-label="E-posta">{r.email}</td>
                    <td data-label="Telefon">{r.phone ?? "—"}</td>
                    <td data-label="Bilet">{r.cancelledAt ? "İptal" : r.isCheckedIn ? "Giriş yaptı" : "Bekliyor"}</td>
                    <td data-label="Aydınlatma">Sürüm {r.noticeVersion} · {formatDateTime(r.noticeAcceptedAt)}</td>
                    <td data-label="E-posta izni">{r.marketingConsent && r.marketingConsentAt ? `Evet · ${formatDateTime(r.marketingConsentAt)}` : "Hayır"}</td>
                    <td data-label="Kayıt">{formatDateTime(r.createdAt)}</td>
                    <td>{canWrite && <button className="text-button danger" type="button" onClick={() => setErase(r)}>Verisini sil</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {erase && (
        <Modal className="confirmation-modal" labelledBy="erase-title" onClose={() => setErase(null)}>
          <p className="eyebrow">KİŞİSEL VERİYİ SİL</p>
          <h2 id="erase-title">{erase.fullName} adlı kişinin verileri silinsin mi?</h2>
          <p>Ad, e-posta, telefon ve rıza kayıtları kalıcı olarak silinir (KVKK m. 7 / m. 11 talebi). Bilet geçerli kalır ve sayımlarda anonim olarak yer alır.</p>
          <div>
            <button className="ghost-button" type="button" onClick={() => setErase(null)}>Vazgeç</button>
            <button className="destructive-button" type="button" onClick={eraseOne} disabled={busy}>{busy && <LoadingMark />}Kalıcı Olarak Sil</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
