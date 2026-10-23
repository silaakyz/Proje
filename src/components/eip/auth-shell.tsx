"use client";

/** Shared pieces of the sign-in, password-reset pages: brand panel, text field, password visibility icon. */
import type { ReactNode } from "react";

export function PasswordVisibilityIcon({ hidden }: { hidden: boolean }) {
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

export function BrandPanel() {
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

export function TextField({
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

