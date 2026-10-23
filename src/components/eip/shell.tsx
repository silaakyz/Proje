"use client";
/**
 * App shell: left navigation, mobile menu, and the session guard. Not signed in → /giris; signed in without
 * an organization → /kurulum. Everything inside can rely on useOrg() being loaded.
 */
import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api/client";
import { useEventDetail, useMe, useOrg } from "@/lib/api/hooks";
import { ROLE_LABEL } from "@/lib/ui/labels";
import { AppIcon, ErrorState, type IconName } from "@/components/eip/ui";
import type { Permission } from "@/lib/api/types";

/** `permission`: the tab is shown only to roles that hold it (its data is not readable otherwise). */
export const WORKSPACE_TABS: { label: string; path: string; icon: IconName; permission?: Permission }[] = [
  { label: "Genel", path: "genel", icon: "home" },
  { label: "Öneriler", path: "oneriler", icon: "layers" },
  { label: "Planlama", path: "planlama", icon: "calendar" },
  { label: "Görevler", path: "gorevler", icon: "check" },
  { label: "KPI ve Ölçüm", path: "kpi", icon: "target" },
  { label: "Katılımcılar", path: "katilimcilar", icon: "users" },
  { label: "Check-in", path: "check-in", icon: "qr" },
  { label: "Anketler", path: "anketler", icon: "list" },
  { label: "Analizler", path: "analizler", icon: "chart" },
  { label: "Raporlar", path: "raporlar", icon: "file" },
  { label: "Etki", path: "etki", icon: "map" },
  { label: "Bütçe", path: "butce", icon: "wallet", permission: "budget.read" },
  { label: "Veri Kaynakları", path: "veri-kaynaklari", icon: "refresh" },
];

/** The event id when the current route is inside an event workspace. */
export function useCurrentEventId() {
  const pathname = usePathname();
  const m = pathname?.match(/^\/etkinlikler\/([0-9a-f-]{36})(?:\/|$)/);
  return m?.[1] ?? null;
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const qc = useQueryClient();
  const { orgName, role, email, can } = useOrg();
  const eventId = useCurrentEventId();
  const event = useEventDetail(eventId);
  const [signingOut, setSigningOut] = useState(false);

  const main: { label: string; path: string; icon: IconName }[] = [
    { label: "Panel", path: "/panel", icon: "home" },
    { label: "Yeni Etkinlik", path: "/etkinlikler/yeni", icon: "plus" },
    { label: "Asistan", path: "/asistan", icon: "message" },
    { label: "Çarpan Setleri", path: "/carpan-setleri", icon: "layers" },
    { label: "Metrik Kataloğu", path: "/metrikler", icon: "target" },
    { label: "Ekip", path: "/ekip", icon: "users" },
    { label: "Ayarlar", path: "/ayarlar", icon: "settings" },
  ];

  function go(path: string) {
    onNavigate?.();
    router.push(path);
  }

  async function signOut() {
    setSigningOut(true);
    try {
      await api("/api/auth/sign-out", { method: "POST" });
    } catch {
      /* the cookie is cleared server-side when possible; go to sign-in either way */
    }
    qc.clear();
    router.replace("/giris");
  }

  return (
    <>
      <div>
        <p className="sidebar-wordmark">EIP</p>
        <div className="organization-switcher">
          <span>KURUM</span>
          <p className="organization-name" title={orgName}>{orgName}</p>
        </div>
        <p className="session-role-label">
          {role ? ROLE_LABEL[role] : ""}
        </p>
        <nav className="primary-nav" aria-label="Ana menü">
          {main.map((item) => (
            <button
              className={`nav-item${pathname === item.path ? " selected" : ""}`}
              type="button"
              key={item.path}
              onClick={() => go(item.path)}
            >
              <AppIcon name={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>
        {eventId && (
          <nav className="primary-nav event-nav" aria-label="Etkinlik menüsü">
            <p className="nav-group-label" title={event.data?.title}>
              {event.data?.title ?? "Etkinlik"}
            </p>
            {WORKSPACE_TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => {
              const path = `/etkinlikler/${eventId}/${tab.path}`;
              return (
                <button
                  className={`nav-item${pathname === path || pathname.startsWith(`${path}/`) ? " selected" : ""}`}
                  type="button"
                  key={tab.path}
                  onClick={() => go(path)}
                >
                  <AppIcon name={tab.icon} />
                  {tab.label}
                </button>
              );
            })}
          </nav>
        )}
      </div>
      <div className="sidebar-account">
        <span>HESAP</span>
        <p title={email ?? undefined}>{email}</p>
        <button type="button" onClick={signOut} disabled={signingOut}>
          <AppIcon name="logout" />
          {signingOut ? "Çıkış yapılıyor" : "Çıkış Yap"}
        </button>
      </div>
    </>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const [menuOpen, setMenuOpen] = useState(false);

  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  const needsOnboarding = me.data && !me.data.membership;

  useEffect(() => {
    if (unauthenticated) router.replace(`/giris?donus=${encodeURIComponent(pathname ?? "/panel")}`);
    else if (needsOnboarding) router.replace("/kurulum");
  }, [unauthenticated, needsOnboarding, router, pathname]);

  useEffect(() => setMenuOpen(false), [pathname]);

  if (me.isPending || unauthenticated || needsOnboarding) {
    return (
      <div className="shell-loading" aria-busy="true">
        <p className="sidebar-wordmark">EIP</p>
        <span>Çalışma alanı yükleniyor</span>
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="shell-loading">
        <p className="sidebar-wordmark">EIP</p>
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <SidebarContent />
      </aside>
      <header className="mobile-bar">
        <span>EIP</span>
        <button type="button" aria-label="Menüyü aç" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
          <AppIcon name="menu" />
        </button>
      </header>
      {menuOpen && (
        <div className="mobile-nav-sheet" role="dialog" aria-modal="true" aria-label="Menü">
          <div className="mobile-nav-heading">
            <span>EIP</span>
            <button type="button" aria-label="Menüyü kapat" onClick={() => setMenuOpen(false)}>
              <AppIcon name="close" />
            </button>
          </div>
          <SidebarContent onNavigate={() => setMenuOpen(false)} />
        </div>
      )}
      <div className="shell-content">{children}</div>
    </div>
  );
}

/** The same session guard as AppShell, without the navigation (full-screen pages such as the door scanner). */
export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useMe();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;
  const needsOnboarding = me.data && !me.data.membership;
  useEffect(() => {
    if (unauthenticated) router.replace(`/giris?donus=${encodeURIComponent(pathname ?? "/panel")}`);
    else if (needsOnboarding) router.replace("/kurulum");
  }, [unauthenticated, needsOnboarding, router, pathname]);
  if (me.isPending || unauthenticated || needsOnboarding) {
    return (
      <div className="shell-loading" aria-busy="true">
        <p className="sidebar-wordmark">EIP</p>
        <span>Yükleniyor</span>
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="shell-loading">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }
  return <>{children}</>;
}
