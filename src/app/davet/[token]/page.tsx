"use client";
/**
 * Invitation link: shows which organization invites which address with which role. Signed out → sign in or
 * sign up and come back here; signed in without an organization → accept; already a member → say so.
 */
import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { keys, useMe } from "@/lib/api/hooks";
import type { PublicInvitation } from "@/lib/api/types";
import { formatDateTime } from "@/lib/ui/format";
import { ROLE_NAME } from "@/lib/ui/labels";
import { InlineNotice, LoadingMark } from "@/components/eip/ui";

const STATE_TEXT: Record<Exclude<PublicInvitation["state"], "open">, string> = {
  expired: "Bu davetin süresi dolmuş. Kurumdan yeni bir davet isteyin.",
  accepted: "Bu davet kullanılmış.",
  revoked: "Bu davet geri alınmış. Kurumdan yeni bir davet isteyin.",
};

export default function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const router = useRouter();
  const qc = useQueryClient();
  const me = useMe();
  const inv = useQuery({
    queryKey: ["invitation", token],
    queryFn: ({ signal }) => api<{ invitation: PublicInvitation }>(`/api/invitations/${token}`, { signal }).then((r) => r.invitation),
    retry: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const here = `/davet/${token}`;
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  const sameAddress = !!me.data?.user.email && !!inv.data && me.data.user.email.toLowerCase() === inv.data.email.toLowerCase();

  async function accept() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/invitations/${token}`, { method: "POST" });
      await qc.invalidateQueries({ queryKey: keys.me });
      router.replace("/panel");
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  async function switchAccount() {
    await api("/api/auth/sign-out", { method: "POST" }).catch(() => undefined);
    qc.clear();
    router.replace(`/giris?donus=${encodeURIComponent(here)}`);
  }

  return (
    <main className="setup-page">
      <div className="setup-column invitation-column">
        <header className="setup-header">
          <p className="eyebrow setup-eyebrow">EKİP DAVETİ</p>
          {inv.isPending ? (
            <h1>Davet yükleniyor…</h1>
          ) : inv.isError ? (
            <>
              <h1>Davet açılamadı</h1>
              <p>{errorMessage(inv.error)}</p>
            </>
          ) : (
            <>
              <h1>
                <em>{inv.data.organizationName}</em> sizi ekibine davet ediyor
              </h1>
              <p>
                Davet edilen adres: <strong>{inv.data.email}</strong> · Rol: <strong>{ROLE_NAME[inv.data.role]}</strong>
                {inv.data.state === "open" ? ` · Son geçerlilik: ${formatDateTime(inv.data.expiresAt)}` : ""}
              </p>
            </>
          )}
        </header>

        {inv.data && (
          <div className="setup-form">
            {error && <InlineNotice tone="error">{error}</InlineNotice>}
            {inv.data.state !== "open" ? (
              <InlineNotice tone="warning">{STATE_TEXT[inv.data.state]}</InlineNotice>
            ) : me.isPending ? (
              <LoadingMark />
            ) : signedOut ? (
              <>
                <p className="form-modal-note">Daveti kabul etmek için <strong>{inv.data.email}</strong> adresiyle giriş yapın; hesabınız yoksa bu adresle kayıt olun.</p>
                <div className="setup-actions">
                  <Link className="primary-button setup-primary" href={`/giris?durum=kayit&donus=${encodeURIComponent(here)}`}>
                    Kayıt Ol
                  </Link>
                  <Link className="ghost-button" href={`/giris?donus=${encodeURIComponent(here)}`}>
                    Giriş Yap
                  </Link>
                </div>
              </>
            ) : me.data?.membership ? (
              <InlineNotice tone="warning">
                {me.data.user.email} hesabı zaten {me.data.membership.organization.name} kurumuna bağlı. Bir hesap yalnızca bir kuruma üye olabilir.
                Daveti kullanmak için <strong>{inv.data.email}</strong> adresiyle oturum açın.
              </InlineNotice>
            ) : !sameAddress ? (
              <>
                <InlineNotice tone="warning">
                  Şu anda {me.data?.user.email} olarak oturum açtınız. Bu davet <strong>{inv.data.email}</strong> adresi için.
                </InlineNotice>
                <div className="setup-actions">
                  <button className="primary-button setup-primary" type="button" onClick={switchAccount}>
                    Hesap Değiştir
                  </button>
                </div>
              </>
            ) : (
              <div className="setup-actions">
                <button className="primary-button setup-primary" type="button" onClick={accept} disabled={busy}>
                  {busy && <LoadingMark />}
                  <span>Daveti Kabul Et</span>
                </button>
              </div>
            )}
            {me.data?.membership && (
              <div className="setup-actions">
                <Link className="ghost-button" href="/panel">
                  Panele Dön
                </Link>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
