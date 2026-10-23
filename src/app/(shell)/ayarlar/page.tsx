"use client";
/** Account (password, sessions) and organization settings (name, type — owner/admin). */
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useMe, useOrg } from "@/lib/api/hooks";
import type { OrganizerType } from "@/lib/api/types";
import { ORGANIZER_TYPE_OPTIONS, ROLE_LABEL, ROLE_NAME } from "@/lib/ui/labels";
import { InlineNotice, LoadingMark, useToast } from "@/components/eip/ui";

function PasswordCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (next.length < 8) return setError("Yeni şifre en az 8 karakter olmalı.");
    if (next.length > 72) return setError("Yeni şifre en fazla 72 karakter olabilir.");
    if (next !== repeat) return setError("Yeni şifreler birbiriyle aynı değil.");
    setBusy(true);
    try {
      const r = await api<{ endedSessions: number }>("/api/account/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
      setCurrent("");
      setNext("");
      setRepeat("");
      await qc.invalidateQueries({ queryKey: ["sessions"] });
      toast(r.endedSessions ? `Şifre değiştirildi. Diğer ${r.endedSessions} oturum kapatıldı.` : "Şifre değiştirildi.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="form-modal settings-card" aria-labelledby="password-title">
      <p className="eyebrow">GÜVENLİK</p>
      <h2 id="password-title">Şifre değiştir</h2>
      <form onSubmit={submit} noValidate>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <label>
          <span>Mevcut şifre</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <div className="form-modal-row">
          <label>
            <span>Yeni şifre</span>
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </label>
          <label>
            <span>Yeni şifre (tekrar)</span>
            <input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
          </label>
        </div>
        <p className="form-modal-note">Şifre değişince bu cihaz dışındaki bütün oturumlar kapatılır.</p>
        <div className="form-modal-actions">
          <button className="primary-button" type="submit" disabled={busy || !current || !next}>
            {busy && <LoadingMark />}
            Şifreyi Değiştir
          </button>
        </div>
      </form>
    </section>
  );
}

function SessionsCard() {
  const toast = useToast();
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: ({ signal }) => api<{ activeSessions: number }>("/api/account/sessions", { signal }) });
  const [busy, setBusy] = useState(false);
  const others = Math.max(0, (sessions.data?.activeSessions ?? 1) - 1);

  return (
    <section className="form-modal settings-card" aria-labelledby="sessions-title">
      <p className="eyebrow">OTURUMLAR</p>
      <h2 id="sessions-title">Açık oturumlar</h2>
      <p className="form-modal-note">
        {sessions.isPending ? "Yükleniyor…" : others ? `Bu cihaz dışında ${others} açık oturumunuz var.` : "Yalnızca bu cihazda oturum açık."}
      </p>
      <div className="form-modal-actions">
        <button
          className="outline-button"
          type="button"
          disabled={busy || !others}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ endedSessions: number }>("/api/account/sessions", { method: "DELETE" });
              await qc.invalidateQueries({ queryKey: ["sessions"] });
              toast(`${r.endedSessions} oturum kapatıldı.`);
            } catch (e) {
              toast(errorMessage(e), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <LoadingMark />}
          Diğer Cihazlardan Çıkış Yap
        </button>
      </div>
    </section>
  );
}

function OrganizationCard() {
  const me = useMe();
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const org = me.data?.membership?.organization;
  const [name, setName] = useState(org?.name ?? "");
  const [type, setType] = useState<OrganizerType>(org?.organizerType ?? "OTHER");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const editable = can("org.manage");

  useEffect(() => {
    if (org) {
      setName(org.name);
      setType(org.organizerType);
    }
  }, [org]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (name.trim().length < 2) return setError("Kurum adını girin (en az 2 karakter).");
    setBusy(true);
    try {
      await api("/api/org", { method: "PATCH", body: { organizationId: orgId, name: name.trim(), organizerType: type } });
      await qc.invalidateQueries({ queryKey: keys.me });
      toast("Kurum bilgileri güncellendi.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const unchanged = !org || (name.trim() === org.name && type === org.organizerType);

  return (
    <section className="form-modal settings-card" aria-labelledby="org-title">
      <p className="eyebrow">KURUM</p>
      <h2 id="org-title">Kurum bilgileri</h2>
      <form onSubmit={submit} noValidate>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <label>
          <span>Kurum adı</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={!editable} />
        </label>
        <label>
          <span>Kurum türü</span>
          <select value={type} onChange={(e) => setType(e.target.value as OrganizerType)} disabled={!editable}>
            {ORGANIZER_TYPE_OPTIONS.map((o) => (
              <option value={o.value} key={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="form-modal-note">Kurum türü, yapay zekânın plan önerilerinde kullandığı dili ve modülleri etkiler.</p>
        {editable ? (
          <div className="form-modal-actions">
            <button className="primary-button" type="submit" disabled={busy || unchanged}>
              {busy && <LoadingMark />}
              Kaydet
            </button>
          </div>
        ) : (
          <p className="form-modal-note">Kurum bilgilerini kurum sahibi veya yöneticiler değiştirebilir.</p>
        )}
      </form>
    </section>
  );
}

export default function SettingsPage() {
  const { orgName, role, email } = useOrg();
  return (
    <main className="multiplier-page settings-page">
      <header className="multiplier-page-header">
        <div>
          <p className="eyebrow">{orgName.toLocaleUpperCase("tr-TR")} · {role ? ROLE_LABEL[role] : ""}</p>
          <h1>Ayarlar</h1>
          <p>
            {email} olarak oturum açtınız{role ? ` · ${ROLE_NAME[role]}` : ""}.
          </p>
        </div>
      </header>
      <div className="settings-grid">
        <OrganizationCard />
        <PasswordCard />
        <SessionsCard />
      </div>
    </main>
  );
}
