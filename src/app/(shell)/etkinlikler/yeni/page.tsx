"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { parsePartialJson } from "ai";
import { api, errorMessage } from "@/lib/api/client";
import { postTextStream } from "@/lib/api/stream";
import { useOrg, useProposals } from "@/lib/api/hooks";
import type { Generation, Proposal } from "@/lib/api/types";
import { formatDate, formatNumber } from "@/lib/ui/format";
import { EVENT_FORMAT_LABEL, MODULE_OPTIONS, moduleLabel } from "@/lib/ui/labels";
import { InlineNotice, LoadingMark, Modal, useToast } from "@/components/eip/ui";
import { ProposalCard } from "@/components/eip/proposals";

type Mode = "writing" | "generating" | "ready" | "error";
type Draft = {
  event?: { title?: string; format?: string; city?: string | null; startDate?: string | null; durationDays?: number | null; expectedAttendance?: number | null };
  objectives?: { text?: string }[];
  proposedModules?: { key?: string }[];
  audience?: string | null;
  stakeholders?: { name?: string }[];
};

const EXAMPLE =
  "İzmir'de 3 gün sürecek, 5.000 katılımcılı bir teknoloji festivali düzenlemek istiyorum. Sponsorlar, stantlar, sahneler, kayıt sistemi ve etki analizi olsun.";
const STORAGE_KEY = "eip.newEvent.draft";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function previewRows(d: Draft | null) {
  const ev = d?.event ?? {};
  return [
    { label: "Etkinlik", value: ev.title },
    { label: "Format", value: ev.format ? EVENT_FORMAT_LABEL[ev.format] ?? ev.format : undefined },
    { label: "Şehir", value: ev.city ?? undefined },
    { label: "Tarih", value: ev.startDate ? `${formatDate(ev.startDate)}${ev.durationDays ? ` · ${ev.durationDays} gün` : ""}` : ev.durationDays ? `${ev.durationDays} gün` : undefined },
    { label: "Beklenen katılım", value: ev.expectedAttendance ? formatNumber(ev.expectedAttendance) : undefined },
    { label: "Hedefler", value: d?.objectives?.map((o) => o.text).filter(Boolean).join(" · ") || undefined },
    { label: "Modüller", value: d?.proposedModules?.map((m) => (m.key ? moduleLabel(m.key) : "")).filter(Boolean).join(" · ") || undefined },
  ];
}

function EmptyEventModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { orgId } = useOrg();
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return setError("Etkinlik adını girin.");
    if (start && end && end < start) return setError("Bitiş tarihi başlangıçtan önce olamaz.");
    setBusy(true);
    try {
      const r = await api<{ event: { id: string } }>("/api/events", { method: "POST", body: { organizationId: orgId, title: title.trim(), startDate: start || null, endDate: end || null } });
      await qc.invalidateQueries({ queryKey: ["events"] });
      router.push(`/etkinlikler/${r.event.id}/genel`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal className="form-modal" labelledBy="empty-event-title" onClose={onClose}>
      <p className="eyebrow">BOŞ ETKİNLİK</p>
      <h2 id="empty-event-title">Plan önerisi olmadan oluştur</h2>
      <form onSubmit={submit}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <label>
          <span>Etkinlik adı</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>
        <div className="form-modal-row">
          <label>
            <span>Başlangıç</span>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label>
            <span>Bitiş</span>
            <input type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        <p className="form-modal-note">Boş etkinlikte görev, KPI ve anket önerisi oluşturulmaz; bilet ve check-in hemen kullanılabilir.</p>
        <div className="form-modal-actions">
          <button className="ghost-button" type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy && <LoadingMark />}
            Etkinliği Oluştur
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function NewEventPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const [mode, setMode] = useState<Mode>("writing");
  const [description, setDescription] = useState("");
  const [modules, setModules] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [error, setError] = useState("");
  const [emptyModal, setEmptyModal] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const pendingCore = useProposals("none");
  const waitingCards = (pendingCore.data ?? []).filter((p) => p.kind === "blueprint.core" && p.status === "PENDING" && p.id !== proposal?.id);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setDescription(saved);
    } catch {
      /* storage unavailable */
    }
    return () => abort.current?.abort();
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, description);
    } catch {
      /* storage unavailable */
    }
  }, [description]);

  async function prepare() {
    if (description.trim().length < 24) {
      setError("Etkinliği biraz daha ayrıntılı anlatın: ne, nerede, ne zaman, kaç kişi ve neyi başarmak istiyorsunuz?");
      setMode("error");
      return;
    }
    setError("");
    setDraft(null);
    setProposal(null);
    setMode("generating");
    abort.current = new AbortController();
    try {
      let lastParse = 0;
      const { headers } = await postTextStream(
        "/api/ai/blueprint",
        { organizationId: orgId, prompt: description.trim(), ...(modules.length ? { modules } : {}) },
        (text) => {
          const now = Date.now();
          if (now - lastParse < 250) return;
          lastParse = now;
          void parsePartialJson(text).then((r) => r.value && typeof r.value === "object" && setDraft(r.value as Draft));
        },
        abort.current.signal,
      );
      const generationId = headers.get("x-generation-id");
      if (!generationId) throw new Error("no generation id");
      // The server validates the streamed draft after the response; poll until it is stored as a card.
      let gen: Generation | null = null;
      for (let i = 0; i < 60; i++) {
        gen = (await api<{ generation: Generation }>(`/api/ai/generations/${generationId}`, { query: { organizationId: orgId } })).generation;
        if (gen.done) break;
        await sleep(1500);
      }
      if (!gen?.done) throw new Error("Plan önerisi zaman aşımına uğradı. Tekrar deneyin.");
      if (gen.status !== "SUCCEEDED" || !gen.proposals.length) {
        setError(
          gen.status === "FAILED_PROVIDER" && gen.failure
            ? `${gen.failure.text}${gen.failure.detail ? `\nAyrıntı: ${gen.failure.detail}` : ""}`
            : gen.quotaExceeded
            ? "Yapay zekâ hizmetinin kullanım kotası doldu (ücretsiz Gemini katmanında günlük istek sınırı vardır). Bir süre sonra veya ertesi gün tekrar deneyin ya da .env dosyasında başka bir model seçin."
            : gen.status === "FAILED_PROVIDER"
            ? "Plan önerisi hizmetine ulaşılamadı. Biraz sonra tekrar deneyin."
            : "Plan önerisi hazırlanamadı. Metni biraz daha ayrıntılandırıp tekrar deneyin.",
        );
        setMode("error");
        return;
      }
      const cards = await api<{ proposals: Proposal[] }>("/api/proposals", { query: { organizationId: orgId, eventId: "none" } });
      const card = cards.proposals.find((p) => p.id === gen!.proposals[0]!.id) ?? null;
      setProposal(card);
      setMode("ready");
      void qc.invalidateQueries({ queryKey: ["proposals", "none"] });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
      setError(e instanceof Error && !("status" in e) ? e.message : errorMessage(e));
      setMode("error");
    }
  }

  async function onDecided(r: { action: "apply"; summary: { eventId: string } } | { action: "reject" }) {
    await qc.invalidateQueries({ queryKey: ["proposals", "none"] });
    if (r.action === "reject") {
      toast("Plan önerisi reddedildi.");
      setProposal(null);
      setMode("writing");
      return;
    }
    const eventId = r.summary.eventId;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    await qc.invalidateQueries({ queryKey: ["events"] });
    try {
      await api("/api/ai/blueprint/sections", { method: "POST", body: { organizationId: orgId, eventId } });
      toast("Etkinlik oluşturuldu. Görev, KPI ve anket önerileri hazırlanıyor.");
      router.push(`/etkinlikler/${eventId}/oneriler?hazirlaniyor=1`);
    } catch (e) {
      toast(`Etkinlik oluşturuldu; bölüm önerileri başlatılamadı: ${errorMessage(e)}`, "error");
      router.push(`/etkinlikler/${eventId}/genel`);
    }
  }

  if (!can("blueprint.generate")) {
    return (
      <main className="proposal-page">
        <section className="writing-paper">
          <p className="eyebrow">YENİ ETKİNLİK</p>
          <h1>Yeni etkinlikleri kurum sahibi veya yönetici oluşturur.</h1>
        </section>
      </main>
    );
  }

  const rows = previewRows(draft);
  const visible = rows.filter((r) => r.value).length;

  const paper = (compact: boolean) => (
    <section className={`writing-paper${compact ? " compact-paper" : ""}`}>
      <header className="proposal-writing-header">
        <p className="eyebrow">YENİ ETKİNLİK</p>
        <h1>Nasıl bir etkinlik planlıyorsunuz?</h1>
        <p>Etkinliğinizi doğal bir dille anlatın. Plan önerisindeki her bölüm onayınızdan önce taslak olarak kalır.</p>
      </header>
      {mode === "error" && error && (
        <div className="proposal-error" role="alert">
          {error.split("\nAyrıntı: ")[0]}
          {error.includes("\nAyrıntı: ") && <small className="proposal-error-detail">Ayrıntı: {error.split("\nAyrıntı: ")[1]}</small>}
        </div>
      )}
      <textarea
        className="proposal-textarea"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder={EXAMPLE}
        aria-label="Etkinlik vizyonu"
        readOnly={compact}
        maxLength={6000}
      />
      <div className="module-options">
        <p>İsteğe bağlı modüller</p>
        <div>
          {MODULE_OPTIONS.map((m) => (
            <button
              className={modules.includes(m.key) ? "selected" : ""}
              type="button"
              key={m.key}
              disabled={compact}
              aria-pressed={modules.includes(m.key)}
              onClick={() => setModules((cur) => (cur.includes(m.key) ? cur.filter((x) => x !== m.key) : [...cur, m.key]))}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      {!compact && (
        <footer className="writing-footer">
          <p>{description ? "Taslak bu cihazda saklanır" : <button type="button" className="text-link" onClick={() => setDescription(EXAMPLE)}>Örnek metni kullan</button>}</p>
          <div>
            <button className="ghost-button proposal-ghost" type="button" onClick={() => setEmptyModal(true)}>
              Boş Etkinlik Oluştur
            </button>
            <button className="primary-button proposal-primary" type="button" onClick={prepare}>
              Plan Önerisi Hazırla
            </button>
          </div>
        </footer>
      )}
    </section>
  );

  return (
    <main className="proposal-page">
      {mode === "generating" ? (
        <div className="generating-layout">
          {paper(true)}
          <section className="generating-preview" aria-live="polite">
            <div className="indeterminate-line" aria-hidden="true">
              <span />
            </div>
            <p className="eyebrow">{visible === rows.length ? "PLAN ÖNERİSİ DOĞRULANIYOR" : "PLAN ÖNERİSİ HAZIRLANIYOR"}</p>
            <div className="preview-rows">
              {rows.map((row) => (
                <div className="preview-row" key={row.label}>
                  {row.value ? (
                    <>
                      <span>{row.label}</span>
                      <strong>{row.value}</strong>
                    </>
                  ) : (
                    <>
                      <span className="preview-skeleton short" />
                      <span className="preview-skeleton" />
                    </>
                  )}
                </div>
              ))}
            </div>
            <button className="ghost-button" type="button" onClick={() => { abort.current?.abort(); setMode("writing"); }}>
              Vazgeç
            </button>
          </section>
        </div>
      ) : mode === "ready" && proposal ? (
        <section className="ready-proposal">
          <p className="eyebrow">PLAN ÖNERİSİ · ETKİNLİK PROFİLİ</p>
          <p className="blueprint-disclaimer">
            Öneri, yazdığınız açıklamadan hazırlandı. Varsayımları kontrol edin; onayladığınızda etkinlik oluşturulur ve görev, KPI ve anket önerileri ayrı kartlar olarak gelir. Hiçbiri onayınız olmadan resmi kayda geçmez.
          </p>
          <ProposalCard proposal={proposal} defaultOpen onDecided={onDecided} />
          <div className="proposal-actions">
            <button className="outline-button" type="button" onClick={() => setMode("writing")}>
              Açıklamayı Düzenle
            </button>
          </div>
        </section>
      ) : (
        <>
          {paper(false)}
          {waitingCards.length > 0 && (
            <section className="pending-core-list">
              <p className="eyebrow">ONAY BEKLEYEN PLAN ÖNERİLERİ</p>
              {waitingCards.map((p) => (
                <ProposalCard key={p.id} proposal={p} onDecided={onDecided} />
              ))}
            </section>
          )}
        </>
      )}
      {emptyModal && <EmptyEventModal onClose={() => setEmptyModal(false)} />}
    </main>
  );
}
