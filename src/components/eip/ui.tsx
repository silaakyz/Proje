"use client";
/** Shared building blocks of the EIP design (ported from the Figma Make prototype). */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/api/client";

export type IconName =
  | "calendar" | "layers" | "users" | "plus" | "search" | "logout" | "menu" | "close" | "arrow-left" | "more" | "check"
  | "chart" | "file" | "message" | "qr" | "home" | "list" | "target" | "map" | "copy" | "printer" | "refresh" | "settings" | "download" | "archive" | "wallet";

const PATHS: Record<IconName, ReactNode> = {
  wallet: (<><path d="M3 7a2 2 0 0 1 2-2h13v4" /><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M16 13.5h2" /></>),
  calendar: (<><path d="M8 2v4M16 2v4M3 9h18" /><rect x="3" y="4" width="18" height="17" rx="2" /></>),
  layers: (<><path d="m12 2 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 17l9 5 9-5" /></>),
  users: (<><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (<><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>),
  logout: (<><path d="M10 17l5-5-5-5M15 12H3" /><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" /></>),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  "arrow-left": <path d="m15 18-6-6 6-6" />,
  more: (<><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>),
  check: <path d="m5 12 4 4L19 6" />,
  chart: <path d="M3 3v18h18M7 15l4-4 3 3 5-6" />,
  file: (<><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6M8 13h8M8 17h5" /></>),
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  qr: (<><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h-3zM20 14v7M14 20h3" /></>),
  home: (<><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></>),
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  target: (<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>),
  map: (<><path d="m9 4-6 2v14l6-2 6 2 6-2V4l-6 2-6-2Z" /><path d="M9 4v14M15 6v14" /></>),
  copy: (<><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></>),
  printer: (<><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><rect x="6" y="14" width="12" height="7" /></>),
  refresh: <path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
  settings: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
  download: <path d="M12 3v12m0 0-5-5m5 5 5-5M4 21h16" />,
  archive: (<><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" /></>),
};

export function AppIcon({ name }: { name: IconName }) {
  return (
    <svg className="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** Badge colour comes from the label text, e.g. "CANLI" → .status-canlı (same rule as the prototype). */
export function StatusBadge({ status }: { status: string }) {
  const statusClass = status.toLocaleLowerCase("tr-TR").replaceAll(" ", "-");
  return (
    <span className={`status-badge status-${statusClass}`}>
      <span className="status-marker" aria-hidden="true" />
      {status}
    </span>
  );
}

export function InlineNotice({ tone, children }: { tone: "error" | "success" | "warning" | "neutral"; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

/** Error box with a retry button, for failed queries. */
export function ErrorState({ error, onRetry, title }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div className="dashboard-notice" role="alert">
      <span>
        {title ? <strong>{title} </strong> : null}
        {errorMessage(error)}
      </span>
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Tekrar Dene
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="events-state empty-state">
      <p>{title}</p>
      {children}
    </div>
  );
}

export function SkeletonRows({ rows = 4, label = "Yükleniyor" }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton-list" aria-label={label} aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <span className="skeleton-title" />
          <span className="skeleton-meta" />
          <span className="skeleton-status" />
        </div>
      ))}
    </div>
  );
}

export function LoadingMark() {
  return <span className="loading-mark" aria-hidden="true" />;
}

/** Modal frame: backdrop click and Escape close it; focus moves into the dialog. */
export function Modal({ children, onClose, className, labelledBy }: { children: ReactNode; onClose: () => void; className: string; labelledBy: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    const first = ref.current?.querySelector<HTMLElement>("input, textarea, select, button");
    first?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={ref} className={className} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ toast

const ToastContext = createContext<(message: string, tone?: "neutral" | "error") => void>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; tone: "neutral" | "error"; id: number } | null>(null);
  const show = useCallback((message: string, tone: "neutral" | "error" = "neutral") => setToast({ message, tone, id: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`result-toast${toast.tone === "error" ? " toast-error" : ""}`} role="status" key={toast.id}>
          <span>{toast.message}</span>
          <button type="button" aria-label="Bildirimi kapat" onClick={() => setToast(null)}>
            <AppIcon name="close" />
          </button>
        </div>
      )}
    </ToastContext.Provider>
  );
}

/** Simple copy-to-clipboard with a short "Kopyalandı" state. */
export function useCopy() {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, []);
  return { copied, copy };
}
