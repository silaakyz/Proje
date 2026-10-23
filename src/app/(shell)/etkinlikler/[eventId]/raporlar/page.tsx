"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/api/client";
import { postTextStream } from "@/lib/api/stream";
import { useEventDetail, useImpactRuns, useOrg } from "@/lib/api/hooks";
import { formatDateTime, formatTry } from "@/lib/ui/format";
import { IMPACT_LEVEL_LABEL } from "@/lib/ui/labels";
import { AppIcon, InlineNotice, LoadingMark, useCopy } from "@/components/eip/ui";
import { RichText } from "@/components/eip/rich-text";
import { SectionHeading, useEventId } from "@/components/eip/workspace";

export default function ReportsPage() {
  const eventId = useEventId();
  const router = useRouter();
  const { orgId } = useOrg();
  const event = useEventDetail(eventId);
  const runs = useImpactRuns(eventId);
  const [draft, setDraft] = useState("");
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState("");
  const { copied, copy } = useCopy();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function generate() {
    setBusy(true);
    setError("");
    setDraft("");
    abort.current = new AbortController();
    try {
      await postTextStream(
        "/api/ai/assistant",
        { organizationId: orgId, eventId, mode: "report", messages: [{ role: "user", content: "Bu etkinlik için yönetim özeti taslağını hazırla." }] },
        setDraft,
        abort.current.signal,
      );
      setGeneratedAt(new Date().toISOString());
    } catch (e) {
      if ((e as Error)?.name !== "AbortError") setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const latest = runs.data?.[0];

  /** The PDF is built on the server from stored records; the draft (if any) is appended as a labelled annex. */
  async function downloadPdf() {
    setPdfBusy(true);
    setPdfError("");
    try {
      const res = await fetch(`/api/events/${eventId}/report`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ organizationId: orgId, summary: draft || null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : `Rapor oluşturulamadı (HTTP ${res.status}).`);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "etkinlik-raporu.pdf";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : String(e));
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <div className="reports-content">
      <section className="placeholder-hero">
        <p className="eyebrow">RAPORLAR</p>
        <h2>Paylaşılabilir çıktılar</h2>
        <p>Yönetim özeti, kayıtlı verilerden taslak olarak hazırlanır. Ekonomik etki bölümleri yalnızca kayıtlı hesaplamalara atıf yapar.</p>
      </section>

      <section className="report-pdf">
        <div>
          <h3>Etkinlik raporu (PDF)</h3>
          <p className="muted-text">
            Katılım, görevler, KPI'lar, anketler ve son etki hesaplaması; bütçe yalnızca bütçeyi görebilen rollerin raporunda yer alır.
            {draft ? " Hazırladığınız yönetim özeti taslağı rapora ek olarak eklenir." : " Yönetim özeti taslağı hazırlarsanız rapora ek olarak eklenir."}
          </p>
          {pdfError && <InlineNotice tone="error">{pdfError}</InlineNotice>}
        </div>
        <button className="primary-button" type="button" onClick={downloadPdf} disabled={pdfBusy || busy}>
          {pdfBusy ? <LoadingMark /> : <AppIcon name="download" />}
          PDF Rapor İndir
        </button>
      </section>

      <div className="placeholder-preview-grid overview-stats">
        <article>
          <span>01 · Yönetim özeti</span>
          <p>{draft ? "Taslak hazır" : "Henüz hazırlanmadı"}<small>{generatedAt ? formatDateTime(generatedAt) : "Asistan ile oluşturun"}</small></p>
        </article>
        <article>
          <span>02 · Etki kaydı</span>
          <p>
            {latest ? (latest.achievedLevel ? IMPACT_LEVEL_LABEL[latest.achievedLevel] : "Yetersiz veri") : "Hesaplama yok"}
            <small>{latest ? `Kayıt ${latest.id.slice(0, 8)} · ${formatDateTime(latest.createdAt, false)}` : "Etki sekmesinden çalıştırın"}</small>
          </p>
        </article>
        <article>
          <span>03 · Brüt harcama (tahmin)</span>
          <p>
            {formatTry(latest?.figures?.grossDirectSpend)}
            <small>{latest?.figures?.attributableSpend != null ? `Atfedilebilir ${formatTry(latest.figures.attributableSpend)}` : "Atfedilebilir seviye yok"}</small>
          </p>
        </article>
      </div>

      <section className="report-draft">
        <SectionHeading eyebrow="YÖNETİM ÖZETİ" title={event.data ? `${event.data.title} · taslak` : "Taslak"}>
          {draft && !busy && (
            <>
              <button className="outline-button" type="button" onClick={() => copy(draft)}>
                <AppIcon name="copy" />
                {copied ? "Kopyalandı" : "Metni Kopyala"}
              </button>
              <button className="outline-button" type="button" onClick={() => window.print()}>
                <AppIcon name="printer" />
                Yazdır
              </button>
            </>
          )}
          <button className="primary-button" type="button" onClick={generate} disabled={busy}>
            {busy && <LoadingMark />}
            {draft ? "Taslağı Yeniden Hazırla" : "Taslak Hazırla"}
          </button>
        </SectionHeading>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        {draft ? (
          <article className="report-paper">
            <p className="eyebrow">TASLAK · YETKİLİ ONAYINDAN ÖNCE PAYLAŞMAYIN</p>
            <RichText text={draft} />
            {latest && <p className="report-cite">Etki rakamları için kaynak: hesaplama kaydı {latest.id} ({formatDateTime(latest.createdAt)}).</p>}
          </article>
        ) : busy ? (
          <p className="muted-text"><LoadingMark /> Kayıtlar okunuyor ve taslak yazılıyor…</p>
        ) : (
          <div className="placeholder-note">
            <strong>Taslak henüz yok</strong>
            <span>“Taslak Hazırla” ile katılım, görev, anket ve etki kayıtlarından bir yönetim özeti oluşturulur. Eksik veriler raporda açıkça belirtilir.</span>
          </div>
        )}
        {!latest && (
          <p className="muted-text">
            Etki bölümünü doldurmak için önce{" "}
            <button type="button" className="text-link" onClick={() => router.push(`/etkinlikler/${eventId}/etki`)}>
              Etki sekmesinde hesaplamayı çalıştırın
            </button>
            .
          </p>
        )}
      </section>
    </div>
  );
}
