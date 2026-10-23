"use client";

import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, errorMessage } from "@/lib/api/client";
import { keys, useMultiplierSets, useOrg } from "@/lib/api/hooks";
import type { MultiplierSet } from "@/lib/api/types";
import { formatDecimal, parseTrNumber } from "@/lib/ui/format";
import { MULTIPLIER_METHOD_LABEL, MULTIPLIER_TYPE_LABEL, NUTS2_OPTIONS, ROLE_LABEL, SPEND_CATEGORIES, SPEND_CATEGORY_LABEL } from "@/lib/ui/labels";
import { EmptyState, ErrorState, InlineNotice, LoadingMark, Modal, SkeletonRows, useToast } from "@/components/eip/ui";

const COLS = [
  { key: "output", label: "Çıktı" },
  { key: "valueAdded", label: "Katma değer" },
  { key: "income", label: "Gelir" },
  { key: "employmentPerMTry", label: "İstihdam (1 mn ₺ başına)" },
] as const;
type Col = (typeof COLS)[number]["key"];

function MultiplierSetModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId } = useOrg();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [region, setRegion] = useState("TR31");
  const [method, setMethod] = useState("FLQ");
  const [type, setType] = useState("TYPE_I");
  const [ioBaseYear, setIoBaseYear] = useState("2012");
  const [priceYear, setPriceYear] = useState("2026");
  const [cells, setCells] = useState<Record<string, Record<Col, string>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const national = region === "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!name.trim()) return setError("Set adını girin.");
    if (source.trim().length < 10) return setError("Kaynak en az 10 karakter olmalı (tablo, yıl, yayımlayan kurum).");
    const coefficients = [];
    for (const cat of SPEND_CATEGORIES) {
      const row = cells[cat];
      if (!row || COLS.every((c) => !row[c.key]?.trim())) continue;
      const values: Record<string, number | null> = {};
      for (const c of COLS) {
        const n = parseTrNumber(row[c.key] ?? "");
        if (c.key === "employmentPerMTry" && n === null) {
          values[c.key] = null; // optional: no employment figure is reported without a coefficient
          continue;
        }
        if (n === null || Number.isNaN(n) || n < 0 || n > 9999) return setError(`${SPEND_CATEGORY_LABEL[cat]} · ${c.label}: 0 ile 9.999 arasında bir sayı girin.`);
        values[c.key] = n;
      }
      coefficients.push({ spendCategory: cat, ...values });
    }
    if (!coefficients.length) return setError("En az bir harcama kategorisi için katsayıları girin.");
    setBusy(true);
    try {
      await api("/api/multiplier-sets", {
        method: "POST",
        body: {
          organizationId: orgId, name: name.trim(), source: source.trim(), ioBaseYear: Number(ioBaseYear), priceYear: Number(priceYear),
          nuts2Code: national ? null : region, method: national ? "NATIONAL" : method, multiplierType: type, coefficients,
        },
      });
      toast("Çarpan seti kaydedildi.");
      await qc.invalidateQueries({ queryKey: keys.multiplierSets(orgId) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal className="multiplier-modal" labelledBy="multiplier-modal-title" onClose={onClose}>
      <header>
        <div>
          <p className="eyebrow">YENİ ÇARPAN SETİ</p>
          <h2 id="multiplier-modal-title">Katsayı setini tanımlayın</h2>
        </div>
        <button type="button" aria-label="Pencereyi kapat" onClick={onClose}>
          ×
        </button>
      </header>
      <form onSubmit={submit}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <div className="multiplier-metadata">
          <label>
            <span>Ad</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Örn. TR31 İzmir · Bölgesel set" maxLength={200} />
          </label>
          <label>
            <span>Kaynak</span>
            <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Örn. TÜİK 2012 Girdi-Çıktı tablosu, FLQ ile bölgeselleştirildi" maxLength={1000} />
          </label>
          <label>
            <span>Bölge</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">Türkiye (ulusal)</option>
              {NUTS2_OPTIONS.map((o) => (
                <option value={o.code} key={o.code}>{o.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Yöntem</span>
            <select value={national ? "NATIONAL" : method} disabled={national} onChange={(e) => setMethod(e.target.value)}>
              {(national ? ["NATIONAL"] : ["SLQ", "CILQ", "FLQ", "SURVEY_BASED"]).map((m) => (
                <option value={m} key={m}>{MULTIPLIER_METHOD_LABEL[m]}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Tür</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              <option value="TYPE_I">Tip I</option>
              <option value="TYPE_II">Tip II</option>
            </select>
          </label>
          <label>
            <span>Tablo baz yılı</span>
            <input type="number" min="1990" max="2100" value={ioBaseYear} onChange={(e) => setIoBaseYear(e.target.value)} />
          </label>
          <label>
            <span>Fiyat yılı</span>
            <input type="number" min="1990" max="2100" value={priceYear} onChange={(e) => setPriceYear(e.target.value)} />
          </label>
        </div>

        <div className="coefficient-table-wrap">
          <table className="coefficient-table">
            <thead>
              <tr>
                <th>Harcama kategorisi</th>
                {COLS.map((c) => (
                  <th key={c.key}>{c.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SPEND_CATEGORIES.map((cat) => (
                <tr key={cat}>
                  <th>{SPEND_CATEGORY_LABEL[cat]}</th>
                  {COLS.map((c) => (
                    <td key={c.key}>
                      <input
                        type="text"
                        inputMode="decimal"
                        placeholder="—"
                        value={cells[cat]?.[c.key] ?? ""}
                        aria-label={`${SPEND_CATEGORY_LABEL[cat]} ${c.label} katsayısı`}
                        onChange={(e) => setCells((s) => ({ ...s, [cat]: { ...(s[cat] ?? ({} as Record<Col, string>)), [c.key]: e.target.value } }))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="immutable-note">
          Katsayılar yayımlanmış bir kaynaktan girilmelidir; sistem varsayılan katsayı üretmez. Kaydedildikten sonra değiştirilemez; düzeltme için yeni bir set oluşturun. Boş bırakılan kategoriler sete eklenmez.
        </p>
        <footer>
          <button className="ghost-button" type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy && <LoadingMark />}
            Çarpan Setini Kaydet
          </button>
        </footer>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------- TÜİK 2023 I-O

const A10 = [
  { key: "A", label: "A · Tarım, ormancılık, balıkçılık" },
  { key: "B-E", label: "B-E · Sanayi" },
  { key: "F", label: "F · İnşaat" },
  { key: "G-I", label: "G-I · Ticaret, ulaştırma, konaklama" },
  { key: "J", label: "J · Bilgi ve iletişim" },
  { key: "K", label: "K · Finans ve sigorta" },
  { key: "L", label: "L · Gayrimenkul" },
  { key: "M-N", label: "M-N · Mesleki ve idari hizmetler" },
  { key: "O-Q", label: "O-Q · Kamu, eğitim, sağlık" },
  { key: "R-U", label: "R-U · Diğer hizmetler" },
] as const;

interface IoPreview {
  method: "NATIONAL" | "FLQ";
  source: string;
  engineVersion: string;
  region: { lambda: number; regionalShare: number; slqA10: Record<string, number> } | null;
  categories: {
    spendCategory: string;
    mapping: string;
    output: number;
    valueAdded: number;
    income: number;
    bridge: { basic: number; margins: number; taxes: number; imports: number; domesticDemand: number };
  }[];
}

const pct = (x: number) => `%${(x * 100).toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`;

function IoMultiplierModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId } = useOrg();
  const [scope, setScope] = useState<"NATIONAL" | "FLQ">("NATIONAL");
  const [name, setName] = useState("TÜİK 2023 · Türkiye (ulusal, Tip I)");
  const [region, setRegion] = useState("TR31");
  const [delta, setDelta] = useState("");
  const [deltaSource, setDeltaSource] = useState("");
  const [dataSource, setDataSource] = useState("");
  const [regional, setRegional] = useState<Record<string, string>>({});
  const [nationalVals, setNationalVals] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<IoPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "save">("");

  function regionBody(): { ok: true; value: unknown } | { ok: false; message: string } {
    if (scope === "NATIONAL") return { ok: true, value: null };
    const d = parseTrNumber(delta);
    if (d === null || Number.isNaN(d) || d < 0 || d >= 1) return { ok: false, message: "δ 0 ile 1 arasında olmalı (0 ≤ δ < 1)." };
    if (deltaSource.trim().length < 10) return { ok: false, message: "δ için kaynak girin (en az 10 karakter)." };
    if (dataSource.trim().length < 10) return { ok: false, message: "Bölgesel A10 verisinin kaynağını girin (en az 10 karakter)." };
    const reg: Record<string, number> = {};
    const nat: Record<string, number> = {};
    for (const s of A10) {
      const r = parseTrNumber(regional[s.key] ?? "");
      const n = parseTrNumber(nationalVals[s.key] ?? "");
      if (r === null || Number.isNaN(r) || r < 0) return { ok: false, message: `${s.label}: bölge değeri girin (0 veya pozitif).` };
      if (n === null || Number.isNaN(n) || n <= 0) return { ok: false, message: `${s.label}: Türkiye değeri pozitif olmalı.` };
      reg[s.key] = r;
      nat[s.key] = n;
    }
    return { ok: true, value: { nuts2Code: region, delta: d, deltaSource: deltaSource.trim(), dataSource: dataSource.trim(), regional: reg, national: nat } };
  }

  async function run(kind: "preview" | "save", e?: FormEvent) {
    e?.preventDefault();
    setError("");
    const r = regionBody();
    if (!r.ok) return setError(r.message);
    if (kind === "save" && !name.trim()) return setError("Set adını girin.");
    setBusy(kind);
    try {
      if (kind === "preview") {
        setPreview(await api<IoPreview>("/api/io/tuik-2023", { method: "POST", body: { organizationId: orgId, region: r.value } }));
      } else {
        await api("/api/multiplier-sets/from-io", { method: "POST", body: { organizationId: orgId, name: name.trim(), region: r.value } });
        toast("TÜİK 2023 çarpan seti kaydedildi.");
        await qc.invalidateQueries({ queryKey: keys.multiplierSets(orgId) });
        await qc.invalidateQueries({ queryKey: ["impact"] });
        onClose();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy("");
    }
  }

  const changeScope = (s: "NATIONAL" | "FLQ") => {
    setScope(s);
    setPreview(null);
    const label = NUTS2_OPTIONS.find((o) => o.code === region)?.label ?? region;
    setName(s === "NATIONAL" ? "TÜİK 2023 · Türkiye (ulusal, Tip I)" : `TÜİK 2023 · ${label} (FLQ, Tip I)`);
  };

  return (
    <Modal className="multiplier-modal" labelledBy="io-modal-title" onClose={onClose}>
      <header>
        <div>
          <p className="eyebrow">TÜİK 2023 GİRDİ-ÇIKTI TABLOLARI</p>
          <h2 id="io-modal-title">Çarpanları tablolardan hesaplayın</h2>
        </div>
        <button type="button" aria-label="Pencereyi kapat" onClick={onClose}>
          ×
        </button>
      </header>
      <form onSubmit={(e) => run("save", e)}>
        {error && <InlineNotice tone="error">{error}</InlineNotice>}
        <p className="io-intro">
          A64 yurt içi üretim tablosundan Leontief tersi (L = (I − A)⁻¹) hesaplanır; anket harcamaları alıcı fiyatıyla olduğu için TÜİK hanehalkı
          sütunundan ticaret/ulaştırma marjı, ürün vergisi ve ithalat ayrıştırılır. Sonuç, 1 ₺ ziyaretçi harcaması başına Tip I çarpandır.
        </p>
        <div className="multiplier-metadata">
          <label>
            <span>Kapsam</span>
            <select value={scope} onChange={(e) => changeScope(e.target.value as "NATIONAL" | "FLQ")}>
              <option value="NATIONAL">Türkiye (ulusal)</option>
              <option value="FLQ">Bölgesel (FLQ)</option>
            </select>
          </label>
          <label className="io-name">
            <span>Set adı</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </label>
          {scope === "FLQ" && (
            <>
              <label>
                <span>Bölge (İBBS-2)</span>
                <select value={region} onChange={(e) => { setRegion(e.target.value); setPreview(null); }}>
                  {NUTS2_OPTIONS.map((o) => (
                    <option value={o.code} key={o.code}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>δ (FLQ parametresi)</span>
                <input type="text" inputMode="decimal" value={delta} onChange={(e) => { setDelta(e.target.value); setPreview(null); }} placeholder="0 ≤ δ < 1" />
              </label>
              <label className="io-wide">
                <span>δ kaynağı</span>
                <input type="text" value={deltaSource} onChange={(e) => setDeltaSource(e.target.value)} maxLength={500} placeholder="Yayın, yıl ve tahminin yapıldığı bölge" />
              </label>
              <label className="io-wide">
                <span>Bölgesel veri kaynağı</span>
                <input type="text" value={dataSource} onChange={(e) => setDataSource(e.target.value)} maxLength={500} placeholder="Örn. TÜİK Bölgesel Hesaplar, İBBS-2 GSKD, A10, 2023, cari fiyat" />
              </label>
            </>
          )}
        </div>

        {scope === "FLQ" && (
          <div className="coefficient-table-wrap">
            <table className="coefficient-table">
              <thead>
                <tr>
                  <th>A10 faaliyet kolu</th>
                  <th>Bölge</th>
                  <th>Türkiye</th>
                  {preview?.region && <th>SLQ</th>}
                </tr>
              </thead>
              <tbody>
                {A10.map((s) => (
                  <tr key={s.key}>
                    <th>{s.label}</th>
                    <td>
                      <input type="text" inputMode="decimal" placeholder="—" aria-label={`${s.label} bölge değeri`} value={regional[s.key] ?? ""}
                        onChange={(e) => { setRegional((v) => ({ ...v, [s.key]: e.target.value })); setPreview(null); }} />
                    </td>
                    <td>
                      <input type="text" inputMode="decimal" placeholder="—" aria-label={`${s.label} Türkiye değeri`} value={nationalVals[s.key] ?? ""}
                        onChange={(e) => { setNationalVals((v) => ({ ...v, [s.key]: e.target.value })); setPreview(null); }} />
                    </td>
                    {preview?.region && <td>{formatDecimal(preview.region.slqA10[s.key])}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="immutable-note">Bölge ve Türkiye değerleri aynı kaynaktan ve aynı birimde olmalı (örn. GSKD, bin ₺). Sistem bölgesel veri ya da δ üretmez.</p>
          </div>
        )}

        {preview && (
          <div className="coefficient-table-wrap">
            {preview.region && (
              <p className="io-intro">
                λ = {formatDecimal(preview.region.lambda)} · bölgenin Türkiye içindeki payı {pct(preview.region.regionalShare)}
              </p>
            )}
            <table className="coefficient-table readonly">
              <thead>
                <tr>
                  <th>Harcama kategorisi</th>
                  <th>Çıktı</th>
                  <th>Katma değer</th>
                  <th>Gelir</th>
                  <th>Yurt içi talep</th>
                  <th>Marj</th>
                  <th>Vergi</th>
                  <th>İthalat</th>
                </tr>
              </thead>
              <tbody>
                {preview.categories.map((c) => (
                  <tr key={c.spendCategory}>
                    <th title={c.mapping}>{SPEND_CATEGORY_LABEL[c.spendCategory] ?? c.spendCategory}</th>
                    <td>{formatDecimal(c.output)}</td>
                    <td>{formatDecimal(c.valueAdded)}</td>
                    <td>{formatDecimal(c.income)}</td>
                    <td>{pct(c.bridge.domesticDemand)}</td>
                    <td>{pct(c.bridge.margins)}</td>
                    <td>{pct(c.bridge.taxes)}</td>
                    <td>{pct(c.bridge.imports)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="immutable-note">
          Tablolarda istihdam verisi olmadığından istihdam katsayısı boş kalır ve etki raporunda istihdam gösterilmez. Ulusal set bölgesel etki
          için kullanılamaz; ithalat ve vergi zaten ayrıldığından etki hesabındaki sızıntı oranı yalnızca bölge dışına kaçan harcamayı kapsamalıdır.
        </p>
        <footer>
          <button className="ghost-button" type="button" onClick={onClose}>
            Vazgeç
          </button>
          <button className="ghost-button" type="button" disabled={!!busy} onClick={() => run("preview")}>
            {busy === "preview" && <LoadingMark />}
            Önizle
          </button>
          <button className="primary-button" type="submit" disabled={!!busy}>
            {busy === "save" && <LoadingMark />}
            Seti Kaydet
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function SetRow({ set }: { set: MultiplierSet }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { orgId, can } = useOrg();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await api(`/api/multiplier-sets/${set.id}`, { method: "PATCH", body: { organizationId: orgId, isActive: !set.isActive } });
      await qc.invalidateQueries({ queryKey: keys.multiplierSets(orgId) });
      await qc.invalidateQueries({ queryKey: ["impact"] });
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <tr>
        <td>
          <button type="button" className="set-name-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <strong>{set.name}</strong>
            <small>{set.coefficients.length} kategori · {open ? "gizle" : "katsayıları göster"}</small>
          </button>
        </td>
        <td className="set-source" title={set.source}><span>{set.source}</span></td>
        <td>{set.nuts2Code ?? "Türkiye"}</td>
        <td>{MULTIPLIER_METHOD_LABEL[set.method] ?? set.method}</td>
        <td>{MULTIPLIER_TYPE_LABEL[set.multiplierType] ?? set.multiplierType}</td>
        <td>{set.priceYear}</td>
        <td>
          <button
            className={`square-toggle${set.isActive ? " active" : ""}`}
            type="button"
            role="switch"
            aria-checked={set.isActive}
            aria-label={`${set.name} aktif durumu`}
            disabled={!can("impact.manage") || busy}
            onClick={toggle}
          >
            <span />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="coefficient-detail-row">
          <td colSpan={7}>
            <table className="coefficient-table readonly">
              <thead>
                <tr>
                  <th>Kategori</th>
                  {COLS.map((c) => <th key={c.key}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {set.coefficients.map((c) => (
                  <tr key={c.spendCategory}>
                    <th>{SPEND_CATEGORY_LABEL[c.spendCategory] ?? c.spendCategory}</th>
                    {COLS.map((k) => <td key={k.key}>{formatDecimal(c[k.key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}

export default function MultiplierSetsPage() {
  const { orgName, role, can } = useOrg();
  const sets = useMultiplierSets();
  const [modal, setModal] = useState(false);
  const [ioModal, setIoModal] = useState(false);

  return (
    <main className="multiplier-page">
      <header className="multiplier-page-header">
        <div>
          <p className="eyebrow">{orgName.toLocaleUpperCase("tr-TR")} · {role ? ROLE_LABEL[role] : ""}</p>
          <h1>Çarpan Setleri</h1>
          <p>Ekonomik etki hesaplamalarında kullanılan bölgesel girdi-çıktı katsayılarını yönetin. Her set kaynağıyla birlikte saklanır.</p>
        </div>
        {can("impact.manage") && (
          <div className="multiplier-header-actions">
            <button className="ghost-button" type="button" onClick={() => setIoModal(true)}>
              TÜİK 2023'ten Hesapla
            </button>
            <button className="primary-button" type="button" onClick={() => setModal(true)}>
              Yeni Çarpan Seti
            </button>
          </div>
        )}
      </header>

      {sets.isPending ? (
        <SkeletonRows rows={3} label="Çarpan setleri yükleniyor" />
      ) : sets.isError ? (
        <ErrorState error={sets.error} onRetry={() => sets.refetch()} />
      ) : !sets.data.length ? (
        <EmptyState title="Henüz çarpan seti yok. Ekonomik etki seviyesi için yayımlanmış bir kaynaktan bölgesel set girin." />
      ) : (
        <div className="multiplier-table-wrap">
          <table className="multiplier-table">
            <thead>
              <tr>
                <th>Ad</th>
                <th>Kaynak</th>
                <th>Bölge</th>
                <th>Yöntem</th>
                <th>Tür</th>
                <th>Fiyat yılı</th>
                <th>Aktif</th>
              </tr>
            </thead>
            <tbody>
              {sets.data.map((s) => (
                <SetRow set={s} key={s.id} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && <MultiplierSetModal onClose={() => setModal(false)} />}
      {ioModal && <IoMultiplierModal onClose={() => setIoModal(false)} />}
    </main>
  );
}
