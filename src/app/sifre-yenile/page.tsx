"use client";

/**
 * Sets a new password from the reset e-mail's link (/sifre-yenile#token). The token is in the URL fragment, which the
 * browser never sends to a server or puts in a Referer; it is read here and removed from the address bar.
 */
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, errorMessage } from "@/lib/api/client";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";
import { BrandPanel, PasswordVisibilityIcon, TextField } from "@/components/eip/auth-shell";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ password?: string; repeat?: string }>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const t = window.location.hash.slice(1);
    setToken(/^[A-Za-z0-9_-]{43}$/.test(t) ? t : null);
    if (t) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") || "");
    const repeat = String(data.get("repeat") || "");
    const errs: typeof fieldErrors = {};
    if (password.length < 8) errs.password = "Şifre en az 8 karakter olmalı.";
    else if (password.length > 72) errs.password = "Şifre en fazla 72 karakter olabilir.";
    if (repeat !== password) errs.repeat = "Şifreler aynı değil.";
    setFieldErrors(errs);
    setError("");
    if (Object.keys(errs).length || !token) return;
    setBusy(true);
    try {
      await api("/api/auth/password-reset/confirm", { method: "POST", body: { token, password } });
      setDone(true);
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
            <h2>Yeni şifre belirleyin</h2>
            <p>Şifreniz değişince tüm cihazlardaki oturumlarınız kapanır.</p>
          </div>
          {done ? (
            <>
              <InlineNotice tone="success">Şifreniz değiştirildi. Yeni şifrenizle giriş yapabilirsiniz.</InlineNotice>
              <button className="primary-button" type="button" onClick={() => router.replace("/giris")}>Giriş Yap</button>
            </>
          ) : token === null ? (
            <InlineNotice tone="error">
              Bağlantı eksik veya geçersiz. E-postadaki bağlantıyı tam olarak açın ya da <Link className="text-link" href="/sifre-sifirla">yeni bir bağlantı isteyin</Link>.
            </InlineNotice>
          ) : (
            <form onSubmit={submit} noValidate>
              {error && <InlineNotice tone="error">{error}</InlineNotice>}
              <div className="field-stack">
                <TextField id="password" label="Yeni şifre" type={show ? "text" : "password"} autoComplete="new-password" helper="En az 8 karakter."
                  error={fieldErrors.password}
                  endAdornment={
                    <button className="icon-button" type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Şifreyi gizle" : "Şifreyi göster"}>
                      <PasswordVisibilityIcon hidden={show} />
                    </button>
                  } />
                <TextField id="repeat" label="Yeni şifre (tekrar)" type={show ? "text" : "password"} autoComplete="new-password" error={fieldErrors.repeat} />
              </div>
              <button className="primary-button" type="submit" disabled={busy || token === undefined}>{busy && <LoadingMark />}Şifreyi Değiştir</button>
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
