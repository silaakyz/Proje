"use client";

import { Suspense, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useAuthOptions } from "@/lib/api/hooks";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";
import { BrandPanel, PasswordVisibilityIcon, TextField } from "@/components/eip/auth-shell";

type Mode = "giris" | "kayit";

function safeReturnPath(p: string | null) {
  return p && p.startsWith("/") && !p.startsWith("//") && !p.startsWith("/giris") ? p : "/panel";
}

function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const options = useAuthOptions();
  const [mode, setMode] = useState<Mode>(params.get("durum") === "kayit" ? "kayit" : "giris");
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState<"form" | null>(null);
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


  return (
    <main className="form-panel">
      <div className="form-column">
        <div className="form-heading">
          <p className="product-mark">EIP</p>
          <h2>{isSignUp ? "Hesap Oluşturun" : "Sisteme Giriş Yapın"}</h2>
          <p>{isSignUp ? "E-posta adresinizle bir hesap açın; ardından kurumunuzu kurar veya bir davete katılırsınız." : "Kurumunuzun çalışma alanına erişin."}</p>
        </div>

        <div className="auth-tabs" role="tablist" aria-label="Giriş veya kayıt">
          <button type="button" role="tab" aria-selected={!isSignUp} className={!isSignUp ? "active" : ""} onClick={() => changeMode("giris")}>Giriş Yap</button>
          <button type="button" role="tab" aria-selected={isSignUp} className={isSignUp ? "active" : ""} onClick={() => changeMode("kayit")}>Kayıt Ol</button>
        </div>

        <form onSubmit={handleSubmit} noValidate key={mode}>
          {formError && <InlineNotice tone="error">{formError}</InlineNotice>}
          {isSignUp && options.data?.signUp === "invite" && (
            <InlineNotice tone="neutral">Bu kurulumda kayıt yalnızca davet edilen e-posta adresleriyle yapılabilir.</InlineNotice>
          )}

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

          {!isSignUp && options.data?.passwordReset && (
            <p className="forgot-link"><Link className="text-link" href="/sifre-sifirla">Şifremi unuttum</Link></p>
          )}

          <button className="primary-button" type="submit" disabled={busy !== null} aria-busy={busy === "form"}>
            {busy === "form" && <LoadingMark />}
            {isSignUp ? "Kayıt Ol" : "Giriş Yap"}
          </button>
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
