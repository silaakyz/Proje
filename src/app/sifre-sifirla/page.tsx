"use client";

/** "Şifremi unuttum": asks for the address and e-mails a one-time link (POST /api/auth/password-reset). */
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { api, errorMessage } from "@/lib/api/client";
import { useAuthOptions } from "@/lib/api/hooks";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";
import { BrandPanel, TextField } from "@/components/eip/auth-shell";

export default function ForgotPasswordPage() {
  const options = useAuthOptions();
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") || "").trim();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setFieldError("Geçerli bir e-posta adresi girin.");
    setFieldError("");
    setBusy(true);
    try {
      await api("/api/auth/password-reset", { method: "POST", body: { email } });
      setSent(email);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-layout">
      <BrandPanel />
      <main className="form-panel">
        <div className="form-column">
          <div className="form-heading">
            <p className="product-mark">EIP</p>
            <h2>Şifremi unuttum</h2>
            <p>Hesabınızın e-posta adresini yazın; yeni şifre belirlemeniz için bir bağlantı gönderelim.</p>
          </div>
          {sent ? (
            <InlineNotice tone="success">
              {sent} adresine kayıtlı bir hesap varsa şifre sıfırlama bağlantısı gönderildi. Bağlantı 60 dakika geçerlidir; gelen kutunuzu ve
              istenmeyen klasörünü kontrol edin.
            </InlineNotice>
          ) : options.data && !options.data.passwordReset ? (
            <InlineNotice tone="warning">
              Bu kurulumda e-posta gönderimi yapılandırılmamış. Şifrenizi sıfırlamak için kurum yöneticinize başvurun.
            </InlineNotice>
          ) : (
            <form onSubmit={submit} noValidate>
              {error && <InlineNotice tone="error">{error}</InlineNotice>}
              <div className="field-stack">
                <TextField id="email" label="E-posta" type="email" autoComplete="email" error={fieldError} />
              </div>
              <button className="primary-button" type="submit" disabled={busy}>{busy && <LoadingMark />}Bağlantı Gönder</button>
            </form>
          )}
          <div className="form-footer">
            <Link className="text-link" href="/giris">Girişe dön</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
