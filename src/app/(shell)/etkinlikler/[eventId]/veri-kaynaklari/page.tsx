"use client";

import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { keys, useDataSources, useEventMetrics, useMentions, useOrg, useUploads } from "@/lib/api/hooks";
import type { CsvUploadResult, DataProvider, DataSourceInfo, MediaMention } from "@/lib/api/types";
import { LEAD_TEMPLATE, SPONSOR_TEMPLATE } from "@/lib/connectors/csv";
import { PROVIDER_CONFIG } from "@/lib/connectors/providers";
import { EXTERNAL_FINANCE_KPI_IDS, EXTERNAL_KPI_IDS } from "@/lib/kpi/external";
import { formatDateTime, formatNumber } from "@/lib/ui/format";
import { MetricsPanel } from "@/components/eip/kpi";
import { AppIcon, ErrorState, InlineNotice, LoadingMark, SkeletonRows, useToast } from "@/components/eip/ui";
import { SectionHeading, useEventId } from "@/components/eip/workspace";

type FieldType = "text" | "number" | "date" | "list" | "lines";
interface Field { name: string; label: string; type: FieldType; placeholder?: string; help?: string; wide?: boolean }

/** Form fields per provider; values are turned into the provider's config and checked with its schema. */
const FIELDS: Record<DataProvider, Field[]> = {
  OPEN_METEO_AIR: [
    { name: "city", label: "Şehir", type: "text", placeholder: "Boş: etkinlik profilindeki şehir" },
    { name: "latitude", label: "Enlem", type: "number", placeholder: "örn. 38,4237", help: "Koordinat girilirse şehir yerine kullanılır" },
    { name: "longitude", label: "Boylam", type: "number", placeholder: "örn. 27,1428" },
  ],
  BREVO: [
    { name: "campaignIds", label: "Kampanya kimlikleri", type: "list", placeholder: "örn. 12, 15, 18", help: "Brevo'da kampanya adresindeki sayı; virgülle ayırın", wide: true },
  ],
  GA4: [
    { name: "propertyId", label: "GA4 mülk kimliği", type: "text", placeholder: "örn. 345678901", help: "Yönetici → Mülk ayarları" },
    { name: "landingPagePath", label: "Açılış sayfası yolu", type: "text", placeholder: "/kordon-festivali", help: "Bu yolla başlayan sayfalar" },
    { name: "registrationEvent", label: "Kayıt olayı adı", type: "text", placeholder: "sign_up", help: "GA4'te kaydı işaretleyen olay" },
    { name: "periodStart", label: "Dönem başı", type: "date", help: "Boş: etkinlikten 30 gün önce" },
    { name: "periodEnd", label: "Dönem sonu", type: "date", help: "Boş: etkinlik bitişi" },
    { name: "baselineStart", label: "Baz dönem başı", type: "date", help: "Boş: dönemden hemen önceki eşit süre" },
    { name: "baselineEnd", label: "Baz dönem sonu", type: "date" },
  ],
  META: [
    { name: "instagramUserId", label: "Instagram işletme hesabı kimliği", type: "text", placeholder: "örn. 17841400000000000" },
    { name: "facebookPageId", label: "Facebook sayfa kimliği", type: "text", placeholder: "örn. 100000000000000" },
    { name: "hashtags", label: "Takip edilecek hashtag'ler", type: "list", placeholder: "kordonfestivali, izmirlezzet", help: "# olmadan, virgülle; Instagram hesabı gerekir", wide: true },
    { name: "periodStart", label: "Dönem başı", type: "date", help: "Boş: etkinlikten 30 gün önce" },
    { name: "periodEnd", label: "Dönem sonu", type: "date", help: "Boş: etkinlikten 14 gün sonra" },
  ],
  YOUTUBE: [
    { name: "videoIds", label: "Videolar", type: "list", placeholder: "video bağlantıları veya kimlikleri, virgülle", wide: true },
    { name: "channelId", label: "Kanal kimliği", type: "text", placeholder: "UC…", help: "Dönemde yayımlanan tüm videolar eklenir" },
    { name: "periodStart", label: "Dönem başı", type: "date" },
    { name: "periodEnd", label: "Dönem sonu", type: "date" },
  ],
  NEWS: [
    { name: "terms", label: "Aranacak ifadeler", type: "lines", placeholder: "Her satıra bir ifade; boş: etkinlik adı", wide: true },
    { name: "periodStart", label: "Dönem başı", type: "date", help: "Boş: etkinlikten 30 gün önce" },
    { name: "periodEnd", label: "Dönem sonu", type: "date", help: "Boş: etkinlikten 14 gün sonra" },
  ],
};

const youtubeId = (s: string) => s.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/)?.[1] ?? s;

function toForm(p: DataProvider, config: Record<string, unknown> | undefined) {
  const out: Record<string, string> = {};
  for (const f of FIELDS[p]) {
    const v = config?.[f.name];
    out[f.name] = v === null || v === undefined ? "" : Array.isArray(v) ? v.join(f.type === "lines" ? "\n" : ", ") : f.type === "number" ? String(v).replace(".", ",") : String(v);
  }
  return out;
}

function toConfig(p: DataProvider, form: Record<string, string>) {
  const config: Record<string, unknown> = {};
  for (const f of FIELDS[p]) {
    const raw = (form[f.name] ?? "").trim();
    if (f.type === "list" || f.type === "lines") {
      const items = raw.split(f.type === "lines" ? /\r?\n/ : /[,\n]/).map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
      config[f.name] = p === "YOUTUBE" && f.name === "videoIds" ? items.map(youtubeId) : items;
    } else if (f.type === "number") config[f.name] = raw ? Number(raw.replace(",", ".")) : null;
    else config[f.name] = raw || null;
  }
  return config;
}

function SourceCard({ info, eventCity }: { info: DataSourceInfo; eventCity: string | null }) {
  const eventId = useEventId();
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const manage = can("data.manage");
  const s = info.source;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(() => toForm(info.provider, s?.config));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "pull" | "remove">("");
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: keys.dataSources(eventId) }), qc.invalidateQueries({ queryKey: keys.metrics(eventId) }),
    qc.invalidateQueries({ queryKey: keys.mentions(eventId) }), qc.invalidateQueries({ queryKey: keys.kpis(eventId) }),
  ]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError("");
    const config = toConfig(info.provider, form);
    const check = PROVIDER_CONFIG[info.provider].safeParse(config);
    if (!check.success) {
      const issue = check.error.issues[0]!;
      const field = FIELDS[info.provider].find((f) => f.name === issue.path[0]);
      return setError(field ? `${field.label}: geçerli bir değer girin${field.help ? ` (${field.help})` : ""}.` : "Ayarları kontrol edin.");
    }
    setBusy("save");
    try {
      await api(`/api/events/${eventId}/data-sources`, { method: "PUT", body: { organizationId: orgId, provider: info.provider, config, enabled: s?.enabled ?? true } });
      toast("Kaynak kaydedildi.");
      setOpen(false);
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  async function pull() {
    setBusy("pull");
    try {
      const r = await api<{ results: { status: "OK" | "ERROR"; summary?: string; error?: string }[] }>(`/api/events/${eventId}/data-sources/pull`,
        { method: "POST", body: { organizationId: orgId, provider: info.provider } });
      const res = r.results[0];
      toast(res?.status === "OK" ? "Veri çekildi." : `Çekilemedi: ${res?.error ?? "bilinmeyen hata"}`, res?.status === "OK" ? undefined : "error");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy("");
    }
  }

  async function toggle() {
    if (!s) return;
    try {
      await api(`/api/events/${eventId}/data-sources`, { method: "PUT", body: { organizationId: orgId, provider: info.provider, config: s.config, enabled: !s.enabled } });
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function remove() {
    if (!s) return;
    setBusy("remove");
    try {
      await api(`/api/data-sources/${s.id}`, { method: "DELETE", query: { organizationId: orgId } });
      toast("Kaynak kaldırıldı.");
      setForm(toForm(info.provider, undefined));
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy("");
    }
  }

  const state = !s ? { cls: "idle", text: "Bağlı değil" }
    : !s.enabled ? { cls: "idle", text: "Duraklatıldı" }
    : s.lastStatus === "ERROR" ? { cls: "error", text: "Hata" }
    : s.lastStatus === "OK" ? { cls: "ok", text: "Güncel" }
    : { cls: "pending", text: "Henüz çekilmedi" };

  return (
    <article className={`data-source-card state-${state.cls}`}>
      <header>
        <div>
          <h3>{info.label}</h3>
          <p className="data-source-state"><span aria-hidden="true" />{state.text}{s?.lastSyncAt ? ` · son çekim ${formatDateTime(s.lastSyncAt)}` : ""}</p>
        </div>
        {manage && s && (
          <button className={`square-toggle${s.enabled ? " active" : ""}`} type="button" role="switch" aria-checked={s.enabled}
            aria-label={`${info.label} otomatik çekim`} onClick={toggle}><span /></button>
        )}
      </header>
      {info.missingEnv.length > 0 && (
        <InlineNotice tone="warning">Sunucuda {info.missingEnv.join(", ")} tanımlı değil. Anahtar <code>.env</code> dosyasına eklenmeden bu kaynak çekilemez.</InlineNotice>
      )}
      {s?.lastStatus === "ERROR" && s.lastError && <p className="data-source-error">{s.lastError}</p>}
      {s?.lastStatus === "OK" && s.lastSummary && <p className="data-source-summary">{s.lastSummary}</p>}
      <p className="data-source-terms">{info.terms} <a href={info.docs} target="_blank" rel="noreferrer">Belgeler</a></p>

      {open ? (
        <form onSubmit={save} className="data-source-form">
          {error && <InlineNotice tone="error">{error}</InlineNotice>}
          <div className="data-source-fields">
            {FIELDS[info.provider].map((f) => {
              const id = `${info.provider}-${f.name}`;
              const describedBy = f.help ? `${id}-help` : undefined;
              return (
                <div key={f.name} className={`data-source-field${f.wide ? " wide" : ""}`}>
                  <label htmlFor={id}>{f.label}</label>
                  {f.type === "lines" ? (
                    <textarea id={id} rows={3} value={form[f.name] ?? ""} placeholder={f.placeholder} aria-describedby={describedBy}
                      onChange={(e) => setForm((x) => ({ ...x, [f.name]: e.target.value }))} />
                  ) : (
                    <input id={id} type={f.type === "date" ? "date" : "text"} inputMode={f.type === "number" ? "decimal" : undefined} value={form[f.name] ?? ""}
                      placeholder={f.name === "city" && eventCity ? `Boş: ${eventCity}` : f.placeholder} aria-describedby={describedBy}
                      onChange={(e) => setForm((x) => ({ ...x, [f.name]: e.target.value }))} />
                  )}
                  {f.help && <small id={describedBy}>{f.help}</small>}
                </div>
              );
            })}
          </div>
          <div className="data-source-actions">
            <button className="ghost-button" type="button" onClick={() => { setOpen(false); setError(""); setForm(toForm(info.provider, s?.config)); }}>Vazgeç</button>
            <button className="primary-button" type="submit" disabled={!!busy}>{busy === "save" && <LoadingMark />}Kaydet</button>
          </div>
          {s && <p className="data-source-terms">Ayar değişirse eski ayarla çekilen veriler silinir.</p>}
        </form>
      ) : manage ? (
        <div className="data-source-actions">
          <button className="outline-button" type="button" onClick={() => setOpen(true)}>{s ? "Ayarlar" : "Bağla"}</button>
          {s && (
            <button className="outline-button" type="button" onClick={pull} disabled={!!busy || info.missingEnv.length > 0}>
              {busy === "pull" ? <LoadingMark /> : <AppIcon name="refresh" />}Şimdi Çek
            </button>
          )}
          {s && <button className="text-button danger" type="button" onClick={remove} disabled={!!busy}>Kaldır</button>}
        </div>
      ) : null}
    </article>
  );
}

function Mentions() {
  const eventId = useEventId();
  const { orgId, can } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const mentions = useMentions(eventId);
  const manage = can("data.manage");
  const [filter, setFilter] = useState<MediaMention["status"]>("CANDIDATE");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: keys.mentions(eventId) }), qc.invalidateQueries({ queryKey: keys.metrics(eventId) }),
    qc.invalidateQueries({ queryKey: keys.kpis(eventId) })]);

  async function review(m: MediaMention, status: MediaMention["status"]) {
    try {
      await api(`/api/mentions/${m.id}`, { method: "PATCH", body: { organizationId: orgId, status } });
      await refresh();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!/^https?:\/\/\S+\.\S+/.test(url.trim())) return toast("Geçerli bir bağlantı girin (https://…).", "error");
    setAdding(true);
    try {
      await api(`/api/events/${eventId}/mentions`, { method: "POST", body: { organizationId: orgId, url: url.trim(), title: title.trim() || null } });
      setUrl(""); setTitle("");
      toast("Basın kupürü eklendi.");
      await refresh();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setAdding(false);
    }
  }

  const all = mentions.data ?? [];
  const counts = { CANDIDATE: 0, VERIFIED: 0, REJECTED: 0 } as Record<MediaMention["status"], number>;
  for (const m of all) counts[m.status]++;
  const rows = all.filter((m) => m.status === filter);
  const LABEL = { CANDIDATE: "Onay bekleyen", VERIFIED: "Doğrulanan", REJECTED: "Reddedilen" } as const;

  return (
    <section className="data-section">
      <SectionHeading eyebrow="BASIN" title="Basın kupürleri" />
      <p className="section-intro">
        Basın taraması etkinlikle ilgili haberleri aday olarak getirir; yalnızca onayladıklarınız &ldquo;basında yer alma&rdquo; sayısına girer.
        Kendi bulduğunuz haberleri bağlantısıyla ekleyebilirsiniz.
      </p>
      <div className="mention-tabs" role="tablist">
        {(Object.keys(LABEL) as MediaMention["status"][]).map((k) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? "active" : ""} type="button" onClick={() => setFilter(k)}>
            {LABEL[k]} <span>{counts[k]}</span>
          </button>
        ))}
      </div>
      {mentions.isPending ? <SkeletonRows rows={3} label="Haberler yükleniyor" />
        : mentions.isError ? <ErrorState error={mentions.error} onRetry={() => mentions.refetch()} />
        : rows.length === 0 ? <p className="muted-text">Bu listede haber yok.</p>
        : (
          <ul className="mention-list">
            {rows.map((m) => (
              <li key={m.id}>
                <div>
                  <a href={m.url} target="_blank" rel="noreferrer">{m.title || m.url}</a>
                  <small>{[m.domain, m.publishedAt ? formatDateTime(m.publishedAt) : null, m.foundBy === "MANUAL" ? "elle eklendi" : m.foundBy === "GDELT" ? "GDELT" : "Google News"].filter(Boolean).join(" · ")}</small>
                </div>
                {manage && (
                  <div className="mention-actions">
                    {m.status !== "VERIFIED" && <button className="text-button" type="button" onClick={() => review(m, "VERIFIED")}>Onayla</button>}
                    {m.status !== "REJECTED" && <button className="text-button danger" type="button" onClick={() => review(m, "REJECTED")}>Reddet</button>}
                    {m.status !== "CANDIDATE" && <button className="text-button" type="button" onClick={() => review(m, "CANDIDATE")}>Geri al</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      {manage && (
        <form className="mention-add" onSubmit={add}>
          <label><span>Haber bağlantısı</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></label>
          <label><span>Başlık (isteğe bağlı)</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={500} /></label>
          <button className="outline-button" type="submit" disabled={adding}>{adding && <LoadingMark />}Kupür Ekle</button>
        </form>
      )}
    </section>
  );
}

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Uploads() {
  const eventId = useEventId();
  const { orgId } = useOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const summary = useUploads(eventId);
  const [result, setResult] = useState<{ kind: string; r: CsvUploadResult } | null>(null);
  const [busy, setBusy] = useState("");

  async function upload(kind: "sponsors" | "leads", e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 1_900_000) return toast("Dosya en fazla 1,9 MB olabilir.", "error");
    setBusy(kind);
    setResult(null);
    try {
      const r = await api<CsvUploadResult>(`/api/events/${eventId}/uploads/${kind}`, { method: "POST", body: { organizationId: orgId, csv: await file.text() } });
      setResult({ kind, r });
      toast(`${formatNumber(r.stored)} satır yüklendi.`);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.uploads(eventId) }), qc.invalidateQueries({ queryKey: keys.metrics(eventId) }),
        qc.invalidateQueries({ queryKey: keys.kpis(eventId) })]);
    } catch (err) {
      if (err instanceof ApiError && err.code === "CSV_INVALID") setResult({ kind, r: err.details as unknown as CsvUploadResult });
      toast(errorMessage(err), "error");
    } finally {
      setBusy("");
    }
  }
  async function clear(kind: "sponsors" | "leads") {
    try {
      await api(`/api/events/${eventId}/uploads/${kind}`, { method: "DELETE", query: { organizationId: orgId } });
      setResult(null);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.uploads(eventId) }), qc.invalidateQueries({ queryKey: keys.metrics(eventId) })]);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  const blocks = [
    { kind: "sponsors" as const, title: "Sponsor listesi", template: SPONSOR_TEMPLATE, file: "sponsor-sablonu.csv",
      text: "Bu ve önceki edisyonun sponsorları; maliyet, sponsorla önceden anlaşılan atfedilen değer ve gösterim sayısı. Sponsor ROI, CPM ve yenileme oranını besler.",
      stat: summary.data ? `${formatNumber(summary.data.sponsors.rows)} satır, bu edisyonda ${formatNumber(summary.data.sponsors.currentEdition)} sponsor` : "" },
    { kind: "leads" as const, title: "Lead listesi", template: LEAD_TEMPLATE, file: "lead-sablonu.csv",
      text: "Stantlarda toplanan lead'ler, takma kimlikle (ad, e-posta, telefon yüklemeyin; bu sütunlar otomatik atılır). Lead, fırsat ve kazanılan gelir metriklerini besler.",
      stat: summary.data ? `${formatNumber(summary.data.leads.rows)} lead, ${formatNumber(summary.data.leads.exhibitors)} stant` : "" },
  ];

  return (
    <section className="data-section">
      <SectionHeading eyebrow="CSV" title="Sponsor ve lead listeleri" />
      <p className="section-intro">Şablonu indirip Excel'de doldurun, &ldquo;CSV UTF-8&rdquo; olarak kaydedip yükleyin. Her yükleme listenin tamamını değiştirir; hatalı satır varsa hiçbir şey kaydedilmez.</p>
      <div className="upload-grid">
        {blocks.map((b) => (
          <article key={b.kind} className="upload-card">
            <h3>{b.title}</h3>
            <p>{b.text}</p>
            {b.stat && <p className="upload-stat">{b.stat}</p>}
            <div className="data-source-actions">
              <button className="text-button" type="button" onClick={() => download(b.file, b.template)}>Şablonu indir</button>
              <label className="outline-button file-button">
                {busy === b.kind ? <LoadingMark /> : <AppIcon name="download" />}CSV Yükle
                <input type="file" accept=".csv,text/csv" onChange={(e) => upload(b.kind, e)} disabled={!!busy} />
              </label>
              {(b.kind === "sponsors" ? summary.data?.sponsors.rows : summary.data?.leads.rows) ? (
                <button className="text-button danger" type="button" onClick={() => clear(b.kind)}>Listeyi sil</button>
              ) : null}
            </div>
            {result?.kind === b.kind && (
              <div className="upload-result">
                {result.r.droppedColumns?.length > 0 && <InlineNotice tone="warning">Kişisel veri olabileceği için atılan sütunlar: {result.r.droppedColumns.join(", ")}</InlineNotice>}
                {result.r.unknownColumns?.length > 0 && <InlineNotice tone="neutral">Tanınmayan sütunlar yok sayıldı: {result.r.unknownColumns.join(", ")}</InlineNotice>}
                {result.r.issues?.length > 0 && (
                  <ul className="upload-issues">
                    {result.r.issues.slice(0, 20).map((i, k) => <li key={k}>Satır {i.line}: {i.message}</li>)}
                    {result.r.issues.length > 20 && <li>… ve {result.r.issues.length - 20} sorun daha</li>}
                  </ul>
                )}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function DataSourcesPage() {
  const eventId = useEventId();
  const { can } = useOrg();
  const sources = useDataSources(eventId);
  const metrics = useEventMetrics(eventId);
  const external = useMemo(() => {
    const ids = new Set<string>([...EXTERNAL_KPI_IDS, ...EXTERNAL_FINANCE_KPI_IDS]);
    return (metrics.data?.values ?? []).filter((v) => ids.has(v.id));
  }, [metrics.data]);

  return (
    <div className="analytics-content data-sources-page">
      <section className="placeholder-hero">
        <p className="eyebrow">VERİ KAYNAKLARI</p>
        <h2>Dış kaynaklardan otomatik ölçüm</h2>
        <p>
          Hava kalitesi, e-posta, web sitesi, sosyal medya ve basın verileri bağladığınız kaynaklardan çekilir ve metriklere dönüşür.
          Kaynaklar etkinlikten 60 gün önce ile 30 gün sonrası arasında, uygulama çalışırken saatte bir kendiliğinden güncellenir.
          Erişim anahtarları sunucunun <code>.env</code> dosyasında tutulur; bu sayfada yalnızca hangi hesabın okunacağı ayarlanır.
        </p>
      </section>

      {sources.isPending ? <SkeletonRows rows={4} label="Kaynaklar yükleniyor" />
        : sources.isError ? <ErrorState error={sources.error} onRetry={() => sources.refetch()} />
        : (
          <div className="data-source-grid">
            {sources.data.providers.map((p) => <SourceCard key={p.provider} info={p} eventCity={sources.data.event.city} />)}
          </div>
        )}

      <Mentions />
      {can("data.manage") && <Uploads />}

      <section className="data-section">
        <SectionHeading eyebrow="METRİKLER" title="Dış kaynaklardan hesaplananlar" />
        <p className="section-intro">Kaynağı bağlı olmayan metrikler boş görünür; KPI sayfasında bu metrikler için değeri elle de girebilirsiniz.</p>
        {metrics.isPending ? <SkeletonRows rows={2} label="Metrikler hesaplanıyor" /> : <MetricsPanel values={external} />}
      </section>
    </div>
  );
}
