"use client";
/**
 * Team: members and their roles, invitations (owner/admin), leaving the organization.
 * Who may do what is decided by the server (src/server/org/team-service.ts); the page only hides what the
 * caller's role cannot do.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useAuthOptions, useInvitations, useMembers, useOrg } from "@/lib/api/hooks";
import type { Invitation, Member, Role } from "@/lib/api/types";
import { formatDate, formatDateTime } from "@/lib/ui/format";
import { ROLE_LABEL, ROLE_NAME } from "@/lib/ui/labels";
import { AppIcon, EmptyState, ErrorState, InlineNotice, LoadingMark, Modal, SkeletonRows, useCopy, useToast } from "@/components/eip/ui";

const inviteUrl = (token: string) => `${window.location.origin}/davet/${token}`;

function InviteModal({ onClose }: { onClose: () => void }) {
  const { orgId, role } = useOrg();
  const qc = useQueryClient();
  const { copy } = useCopy();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "staff">("staff");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [mailed, setMailed] = useState<{ emailed: boolean; emailError?: string } | null>(null);
  const options = useAuthOptions();
  const canEmail = !!options.data?.passwordReset;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError("Geçerli bir e-posta adresi girin.");
    setBusy(true);
    try {
      const r = await api<{ invitation: Invitation; token: string; emailed: boolean; emailError?: string }>("/api/org/invitations", {
        method: "POST",
        body: { organizationId: orgId, email: email.trim(), role: inviteRole },
      });
      setLink(inviteUrl(r.token));
      setMailed({ emailed: r.emailed, emailError: r.emailError });
      await qc.invalidateQueries({ queryKey: keys.invitations(orgId) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal className="form-modal" labelledBy="invite-title" onClose={onClose}>
      <p className="eyebrow">EKİBE DAVET</p>
      <h2 id="invite-title">{link ? (mailed?.emailed ? "Davet gönderildi" : "Davet bağlantısı hazır") : "Ekip arkadaşı davet edin"}</h2>
      {link ? (
        <div className="invite-result">
          {mailed?.emailed ? (
            <p className="form-modal-note">
              Davet e-postası <strong>{email.trim()}</strong> adresine gönderildi. E-posta ulaşmazsa aşağıdaki bağlantıyı kendiniz de
              iletebilirsiniz. Bağlantı 7 gün geçerlidir ve yalnızca bu adresle açılan hesapla kullanılabilir.
            </p>
          ) : (
            <>
              {mailed?.emailError && <InlineNotice tone="warning">E-posta gönderilemedi: {mailed.emailError} Bağlantıyı kendiniz iletin.</InlineNotice>}
              <p className="form-modal-note">
                Bu bağlantıyı <strong>{email.trim()}</strong> adresine iletin. Bağlantı 7 gün geçerlidir ve yalnızca bu adresle açılan
                hesapla kullanılabilir. Güvenliğiniz için bağlantı yalnızca şimdi gösterilir.
              </p>
            </>
          )}
          <div className="invite-link-box">
            <code>{link}</code>
            <button
              className="outline-button"
              type="button"
              onClick={async () => {
                await copy(link);
                toast("Davet bağlantısı kopyalandı.");
              }}
            >
              <AppIcon name="copy" />
              Kopyala
            </button>
          </div>
          <div className="form-modal-actions">
            <button className="primary-button" type="button" onClick={onClose}>
              Tamam
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit} noValidate>
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <label>
            <span>E-posta adresi</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ad.soyad@kurum.gov.tr" autoFocus maxLength={320} />
          </label>
          <label>
            <span>Rol</span>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "admin" | "staff")}>
              <option value="staff">Ekip üyesi — görevler, check-in, anket girişi</option>
              {role === "owner" && <option value="admin">Yönetici — etkinlik, plan, katılımcı ve etki yönetimi</option>}
            </select>
          </label>
          <p className="form-modal-note">Aynı adrese açık bir davet varsa yenisi oluşturulur ve eski bağlantı geçersiz olur.</p>
          <div className="form-modal-actions">
            <button className="ghost-button" type="button" onClick={onClose}>
              Vazgeç
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy && <LoadingMark />}
              {canEmail ? "Davet Gönder" : "Davet Bağlantısı Oluştur"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function ConfirmModal({ title, children, confirmLabel, onConfirm, onClose }: { title: string; children: ReactNode; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal className="form-modal" labelledBy="confirm-title" onClose={onClose}>
      <p className="eyebrow">ONAY</p>
      <h2 id="confirm-title">{title}</h2>
      {error && <InlineNotice tone="error">{error}</InlineNotice>}
      <p className="form-modal-note">{children}</p>
      <div className="form-modal-actions">
        <button className="ghost-button" type="button" onClick={onClose}>
          Vazgeç
        </button>
        <button
          className="destructive-button"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError(errorMessage(e));
              setBusy(false);
            }
          }}
        >
          {busy && <LoadingMark />}
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

function MemberRow({ member, ownerCount }: { member: Member; ownerCount: number }) {
  const { orgId, role } = useOrg();
  const qc = useQueryClient();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const lastOwner = member.role === "owner" && ownerCount <= 1;
  const canChangeRole = role === "owner" && !lastOwner;
  const canRemove = member.isSelf ? !lastOwner : role === "owner" || (role === "admin" && member.role === "staff");

  async function changeRole(next: Role) {
    setBusy(true);
    try {
      await api(`/api/org/members/${member.userId}`, { method: "PATCH", body: { organizationId: orgId, role: next } });
      await qc.invalidateQueries({ queryKey: keys.members(orgId) });
      if (member.isSelf) await qc.invalidateQueries({ queryKey: keys.me });
      toast(`${member.email} artık ${ROLE_NAME[next].toLocaleLowerCase("tr-TR")}.`);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    await api(`/api/org/members/${member.userId}`, { method: "DELETE", query: { organizationId: orgId } });
    if (member.isSelf) {
      qc.clear();
      router.replace("/kurulum");
      return;
    }
    await qc.invalidateQueries({ queryKey: keys.members(orgId) });
    toast(`${member.email} ekipten çıkarıldı.`);
  }

  return (
    <tr>
      <td>
        <strong className="member-email">{member.email}</strong>
        {member.isSelf && <small className="member-self">siz</small>}
      </td>
      <td>
        {canChangeRole ? (
          <select className="table-select" value={member.role} disabled={busy} aria-label={`${member.email} rolü`} onChange={(e) => changeRole(e.target.value as Role)}>
            {(["owner", "admin", "staff"] as const).map((r) => (
              <option value={r} key={r}>
                {ROLE_NAME[r]}
              </option>
            ))}
          </select>
        ) : (
          ROLE_NAME[member.role]
        )}
      </td>
      <td>{formatDate(member.joinedAt.slice(0, 10))}</td>
      <td>{member.lastSignInAt ? formatDateTime(member.lastSignInAt) : "—"}</td>
      <td className="table-actions">
        {canRemove && (
          <button className="text-button danger" type="button" onClick={() => setConfirm(true)}>
            {member.isSelf ? "Ekipten ayrıl" : "Çıkar"}
          </button>
        )}
        {confirm && (
          <ConfirmModal
            title={member.isSelf ? "Kurumdan ayrılıyorsunuz" : "Üyeyi çıkar"}
            confirmLabel={member.isSelf ? "Ayrıl" : "Ekipten Çıkar"}
            onConfirm={remove}
            onClose={() => setConfirm(false)}
          >
            {member.isSelf
              ? "Kurumun etkinliklerine erişiminiz hemen sona erer. Hesabınız silinmez; yeni bir kurum kurabilir veya başka bir davete katılabilirsiniz."
              : `${member.email} kurumun hiçbir verisine erişemeyecek ve açık oturumları kapatılacak. Hesabı silinmez. Yaptığı kayıtlar (görevler, anket girişleri) korunur.`}
          </ConfirmModal>
        )}
      </td>
    </tr>
  );
}

function InvitationRow({ invitation }: { invitation: Invitation }) {
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <tr>
      <td>
        <strong className="member-email">{invitation.email}</strong>
      </td>
      <td>{ROLE_NAME[invitation.role]}</td>
      <td>{invitation.invitedByEmail ?? "—"}</td>
      <td>{formatDateTime(invitation.expiresAt)}</td>
      <td className="table-actions">
        <button
          className="text-button danger"
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/org/invitations/${invitation.id}`, { method: "DELETE", query: { organizationId: orgId } });
              await qc.invalidateQueries({ queryKey: keys.invitations(orgId) });
              toast("Davet geri alındı; bağlantı artık çalışmaz.");
            } catch (e) {
              toast(errorMessage(e), "error");
              setBusy(false);
            }
          }}
        >
          Geri al
        </button>
      </td>
    </tr>
  );
}

export default function TeamPage() {
  const { orgName, role, can } = useOrg();
  const members = useMembers();
  const manage = can("member.manage");
  const invitations = useInvitations(manage);
  const [inviting, setInviting] = useState(false);
  const ownerCount = members.data?.filter((m) => m.role === "owner").length ?? 0;

  return (
    <main className="multiplier-page team-page">
      <header className="multiplier-page-header">
        <div>
          <p className="eyebrow">{orgName.toLocaleUpperCase("tr-TR")} · {role ? ROLE_LABEL[role] : ""}</p>
          <h1>Ekip</h1>
          <p>Kurumunuzun üyeleri ve rolleri. Yöneticiler etkinlikleri, planları, katılımcıları ve etki hesaplarını yönetir; ekip üyeleri görevleri günceller, kapıda check-in yapar ve anket girer.</p>
        </div>
        {manage && (
          <button className="primary-button" type="button" onClick={() => setInviting(true)}>
            Ekip Arkadaşı Davet Et
          </button>
        )}
      </header>

      <section className="team-section">
        <h2 className="team-section-title">Üyeler {members.data ? `(${members.data.length})` : ""}</h2>
        {members.isPending ? (
          <SkeletonRows rows={3} label="Üyeler yükleniyor" />
        ) : members.isError ? (
          <ErrorState error={members.error} onRetry={() => members.refetch()} />
        ) : (
          <div className="multiplier-table-wrap">
            <table className="multiplier-table team-table">
              <thead>
                <tr>
                  <th>E-posta</th>
                  <th>Rol</th>
                  <th>Katılım</th>
                  <th>Son giriş</th>
                  <th aria-label="İşlemler" />
                </tr>
              </thead>
              <tbody>
                {members.data.map((m) => (
                  <MemberRow member={m} ownerCount={ownerCount} key={m.userId} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {role === "owner" && <p className="team-note">Rolleri yalnızca kurum sahipleri değiştirebilir. Kurumda her zaman en az bir kurum sahibi kalır.</p>}
      </section>

      {manage && (
        <section className="team-section">
          <h2 className="team-section-title">Bekleyen davetler</h2>
          {invitations.isPending ? (
            <SkeletonRows rows={2} label="Davetler yükleniyor" />
          ) : invitations.isError ? (
            <ErrorState error={invitations.error} onRetry={() => invitations.refetch()} />
          ) : !invitations.data.length ? (
            <EmptyState title="Bekleyen davet yok." />
          ) : (
            <div className="multiplier-table-wrap">
              <table className="multiplier-table team-table">
                <thead>
                  <tr>
                    <th>E-posta</th>
                    <th>Rol</th>
                    <th>Davet eden</th>
                    <th>Geçerlilik</th>
                    <th aria-label="İşlemler" />
                  </tr>
                </thead>
                <tbody>
                  {invitations.data.map((i) => (
                    <InvitationRow invitation={i} key={i.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
    </main>
  );
}
