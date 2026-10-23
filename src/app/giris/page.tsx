"use client";

import { Suspense, useState, type FormEvent, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useDemoInfo } from "@/lib/api/hooks";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";

type Mode = "giris" | "kayit";

function PasswordVisibilityIcon({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {hidden ? (
        <>
          <path d="m2 2 20 20" />
          <path d="M6.7 6.7C4.8 8 3.2 9.8 2 12c2.1 3.8 5.9 6 10 6 1.4 0 2.8-.3 4-.8" />
          <path d="M10.7 5.1c.4-.1.9-.1 1.3-.1 4.1 0 7.9 2.2 10 7-0.6 1.1-1.3 2-2.2 2.9" />
          <path d="M14.1 14.1A3 3 0 0 1 9.9 9.9" />
        </>
      ) : (
        <>
          <path d="M2.1 12a11.8 11.8 0 0 1 19.8 0 11.8 11.8 0 0 1-19.8 0" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

function BrandPanel() {
  return (
    <section className="brand-panel" aria-label="Event Intelligence Platform">
      <div className="brand-copy">
        <p className="eyebrow brand-eyebrow">EKONOMİK ETKİ ZEKÂSI</p>
        <h1 className="brand-statement">
          Etkinliklerin gerçek etkisini <em>ölçün</em>
        </h1>
      </div>
      <figure className="impact-figure">
        <svg className="impact-chart" viewBox="0 0 520 176" role="img" aria-labelledby="chart-title chart-description">
          <title id="chart-title">Temsili ekonomik etki eğrileri</title>
          <desc id="chart-description">Doğrudan harcama ve dolaylı etkinin zaman içinde artışını gösteren iki çizgi.</desc>
          <path className="chart-axis" d="M0 152H520M0 100H520M0 48H520" />
          <path className="chart-line chart-direct" d="M0 138C55 134 90 128 130 118C180 105 203 109 255 88C305 68 342 74 390 52C435 32 472 29 520 18" />
          <path className="chart-line chart-indirect" d="M0 150C62 149 94 145 138 138C190 130 218 128 267 113C317 98 353 101 400 86C448 70 478 68 520 58" />
          <rect className="chart-marker direct-marker" x="336" y="68" width="8" height="8" />
          <rect className="chart-marker indirect-marker" x="394" y="82" width="8" height="8" />
          <text className="chart-label direct-label" x="350" y="72">Doğrudan harcama</text>
          <text className="chart-label indirect-label" x="410" y="91">Dolaylı etki</text>
        </svg>
        <figcaption>Şekil 1 — Temsili veri.</figcaption>
      </figure>
      <p className="brand-footer">© 2026 Event Intelligence Platform</p>
    </section>
  );
}

function TextField({
  id, label, type = "text", autoComplete, helper, error, endAdornment,
}: { id: string; label: string; type?: string; autoComplete: string; helper?: string; error?: string; endAdornment?: ReactNode }) {
  const descriptionId = helper || error ? `${id}-description` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={`input-wrap${error ? " input-error" : ""}`}>
        <input id={id} name={id} type={type} autoComplete={autoComplete} aria-invalid={Boolean(error)} aria-describedby={descriptionId} required />
        {endAdornment}
      </div>
      {(helper || error) && (
        <p id={descriptionId} className={error ? "field-message error-text" : "field-message"}>
          {error || helper}
        </p>
      )}
    </div>
  );
}

function safeReturnPath(p: string | null) {
  return p && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/giris") ? p : "/panel";
}

function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const demo = useDemoInfo();
  const [mode, setMode] = useState<Mode>(params.get("durum") === "kayit" ? "kayit" : "giris");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<"form" | "demo" | null>(null);
  const isSignUp = mode === "kayit";

  function changeMode(next: Mode) {
    setMode(next);
    setFieldErrors({});
    setFormError("");
  }

  async function enterWorkspace() {
    await qc.invalidateQueries({ queryKey: keys.me });
    const me = await qc.fetchQuery({ queryKey: keys.me, queryFn: () => api<{ membership: unknown }>("/api/me") });
    const back = safeReturnPath(params.get("donus"));
    // An invitation link works for accounts without an organization too (that is who it is for).
    router.replace(me.membership || back.startsWith("/davet/") ? back : "/kurulum");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") || "").trim();
    const password = String(data.get("password") || "");
    const errors: typeof fieldErrors = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = "Geçerli bir e-posta adresi girin.";
    if (password.length < 8) errors.password = "Şifre en az 8 karakter olmalı.";
    setFieldErrors(errors);
    setFormError("");
    if (Object.keys(errors).length) return;

    setBusy("form");
    try {
      // Sign-up signs the new account in at once (no confirmation e-mail); both set the session cookie.
      await api(`/api/auth/${isSignUp ? "sign-up" : "sign-in"}`, { method: "POST", body: { email, password } });
      await enterWorkspace();
    } catch (e) {
      setFormError(errorMessage(e));
      setBusy(null);
    }
  }

  async function demoLogin() {
    setBusy("demo");
    setFormError("");
    try {
      await api("/api/auth/demo", { method: "POST" });
      await enterWorkspace();
    } catch (e) {
      setFormError(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <main className="form-panel">
      <div className="form-column">
        <div className="form-heading">
          <p className="product-mark">EIP</p>
          <h2>{isSignUp ? "Hesap Oluşturun" : "Sisteme Giriş Yapın"}</h2>
          <p>Kurumunuzun çalışma alanına erişin.</p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {formError && <InlineNotice tone="error">{formError}</InlineNotice>}

          <div className="field-stack">
            <TextField id="email" label="E-posta" type="email" autoComplete="email" error={fieldErrors.email} />
            <TextField
              id="password"
              label="Şifre"
              type={showPassword ? "text" : "password"}
              autoComplete={isSignUp ? "new-password" : "current-password"}
              helper={isSignUp ? "En az 8 karakter." : undefined}
              error={fieldErrors.password}
              endAdornment={
                <button
                  className="icon-button"
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
                  title={showPassword ? "Şifreyi gizle" : "Şifreyi göster"}
                >
                  <PasswordVisibilityIcon hidden={showPassword} />
                </button>
              }
            />
          </div>

          <button className="primary-button" type="submit" disabled={busy !== null} aria-busy={busy === "form"}>
            {busy === "form" && <LoadingMark />}
            {isSignUp ? "Kayıt Ol" : "Giriş Yap"}
          </button>
          {!isSignUp && demo.data?.enabled && (
            <button className="outline-button demo-login-button" type="button" onClick={demoLogin} disabled={busy !== null} aria-busy={busy === "demo"}>
              {busy === "demo" && <LoadingMark />}
              Demo Olarak Devam Et
            </button>
          )}
        </form>

        <div className="form-footer">
          <span>{isSignUp ? "Zaten hesabınız var mı?" : "Hesabınız yok mu?"}</span>
          <button className="text-link" type="button" onClick={() => changeMode(isSignUp ? "giris" : "kayit")}>
            {isSignUp ? "Giriş Yapın" : "Kayıt Olun"}
          </button>
        </div>
      </div>
    </main>
  );
}

export default function SignInPage() {
  return (
    <div className="auth-layout">
      <BrandPanel />
      <Suspense>
        <AuthForm />
      </Suspense>
    </div>
  );
}
