"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { keys, useMe } from "@/lib/api/hooks";
import type { OrganizerType } from "@/lib/api/types";
import { ORGANIZER_TYPE_OPTIONS } from "@/lib/ui/labels";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";

export default function OrganizationSetupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = useState("");
  const [type, setType] = useState<OrganizerType>("MUNICIPALITY");
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) router.replace("/giris");
    else if (me.data?.membership) router.replace("/panel");
  }, [me.data, me.error, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length < 2) {
      setNameError("Kurum adını girin (en az 2 karakter).");
      return;
    }
    setNameError("");
    setError("");
    setLoading(true);
    try {
      await api("/api/onboarding", { method: "POST", body: { organizationName: name.trim(), organizerType: type } });
      await qc.invalidateQueries({ queryKey: keys.me });
      router.replace("/panel");
    } catch (e) {
      if (e instanceof ApiError && e.code === "ALREADY_MEMBER") {
        await qc.invalidateQueries({ queryKey: keys.me });
        router.replace("/panel");
        return;
      }
      setError(errorMessage(e));
      setLoading(false);
    }
  }

  async function handleSignOut() {
    await api("/api/auth/sign-out", { method: "POST" }).catch(() => undefined);
    qc.clear();
    router.replace("/giris");
  }

  return (
    <main className="setup-page">
      <div className="setup-column">
        <header className="setup-header">
          <p className="eyebrow setup-eyebrow">ADIM 1 / 1</p>
          <h1>
            Kurumunuzu <em>tanıtın</em>
          </h1>
          <p>Etkinlikleriniz bu kurumun altında toplanır. Ekip arkadaşlarınızı sonra Ekip sayfasından davet edebilirsiniz.</p>
          <p className="setup-invite-hint">Var olan bir kuruma katılacaksanız yeni kurum oluşturmayın; size gönderilen davet bağlantısını açın.</p>
        </header>

        <form className="setup-form" onSubmit={handleSubmit} noValidate>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <div className="field">
            <label htmlFor="organization-name">Kurum adı</label>
            <div className={`input-wrap${nameError ? " input-error" : ""}`}>
              <input
                id="organization-name"
                name="organization-name"
                autoComplete="organization"
                placeholder="Örn. OZBDA"
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "organization-name-description" : undefined}
                maxLength={120}
                required
              />
            </div>
            {nameError && (
              <p id="organization-name-description" className="field-message error-text">
                {nameError}
              </p>
            )}
          </div>

          <fieldset className="organization-type">
            <legend>Kurum türü</legend>
            <div className="type-grid">
              {ORGANIZER_TYPE_OPTIONS.map((o) => (
                <label className={`type-tile${type === o.value ? " selected" : ""}`} key={o.value}>
                  <input type="radio" name="organization-type" value={o.value} checked={type === o.value} onChange={() => setType(o.value)} />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="setup-actions">
            <button className="primary-button setup-primary" type="submit" disabled={loading} aria-busy={loading}>
              {loading && <LoadingMark />}
              <span>{loading ? "Kurum oluşturuluyor" : "Kurumu Oluştur"}</span>
            </button>
            <button className="ghost-button" type="button" onClick={handleSignOut} disabled={loading}>
              Çıkış Yap
            </button>
          </div>
        </form>
      </div>
    </main>
  );
}
