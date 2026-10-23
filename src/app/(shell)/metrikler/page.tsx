"use client";
/**
 * Metric catalog: every KPI of the organization's reference document with its formula, evidence (K/S/T),
 * sources, and whether the platform computes it today or which data it still needs.
 */
import { useMemo, useState } from "react";
import { useOrg } from "@/lib/api/hooks";
import { DATA_NEED_LABEL, KPI_CATALOG, KPI_CATALOG_VERSION, KPI_GROUPS, KPI_SOURCES } from "@/lib/kpi/catalog";
import { KPI_ENGINE_VERSION } from "@/lib/kpi/engine";
import { ROLE_LABEL } from "@/lib/ui/labels";
import { AppIcon } from "@/components/eip/ui";
import { EVIDENCE_LABEL, EvidenceBadge, SourceLinks } from "@/components/eip/kpi";

const DECISIONS = [
  ["Atfedilebilirlik", "Katı kural: şehir dışından gelen, ana nedeni etkinlik olan ve \"etkinlik olmasa gelmezdim\" diyenler. Kısmi kredi yok; duyarlılık analizi sonraki adım."],
  ["Kayıtlı ve gelen", "Kayıtlı = iptal edilmemiş bilet; gelen = check-in yapan bilet. İptal oranının paydası çıkarılan tüm biletlerdir."],
  ["Ziyaretçi sayısı", "Anket paylarını nüfusa taşırken check-in sayısı, check-in yoksa geçerli bilet sayısı kullanılır; hangisinin kullanıldığı değerin yanında yazar."],
  ["Harcama", "Kişi başı = grup harcaması ÷ grup büyüklüğü. Yerel harcamaya konaklama, yeme-içme, şehir içi ulaşım, alışveriş, eğlence-kültür ve diğer girer; şehirlerarası ulaşım ve organizatör kalemleri girmez (çift sayım)."],
  ["CSAT eşiği", "1–5 ölçeğinde 4 ve 5 (üst-2 kutu)."],
  ["Ağırlıklar", "Her yanıtın ağırlığı şimdilik 1; ağırlıklandırma kuralı tanımlanınca formüller değişmeden ağırlıklı çalışır."],
  ["Girdi-çıktı modeli", "TÜİK tabloları ulusaldır; şehir çarpanı FLQ ile bölgeselleştirilir ve δ bölgeye özgü seçilir. Tip II (uyarılmış) etki varsayılan olarak kapalıdır."],
] as const;

export default function MetricCatalogPage() {
  const { orgName, role } = useOrg();
  const [query, setQuery] = useState("");
  const [onlyComputed, setOnlyComputed] = useState(false);
  const q = query.toLocaleLowerCase("tr-TR");
  const groups = useMemo(
    () =>
      KPI_GROUPS.map((g) => ({
        ...g,
        items: KPI_CATALOG.filter(
          (k) => k.group === g.key && (!onlyComputed || k.computable) && (!q || `${k.id} ${k.name} ${k.formula}`.toLocaleLowerCase("tr-TR").includes(q)),
        ),
      })).filter((g) => g.items.length),
    [q, onlyComputed],
  );
  const computed = KPI_CATALOG.filter((k) => k.computable).length;

  return (
    <main className="multiplier-page catalog-page">
      <header className="multiplier-page-header">
        <div>
          <p className="eyebrow">{orgName.toLocaleUpperCase("tr-TR")} · {role ? ROLE_LABEL[role] : ""}</p>
          <h1>Metrik Kataloğu</h1>
          <p>
            "Etkinlik Etki Analizi — KPI ve Formül Referansı (Kaynaklı)" belgesindeki {KPI_CATALOG.length} metrik. {computed} tanesi bugün platformun
            topladığı veriden otomatik hesaplanıyor; diğerleri için gereken veri yanında yazıyor.
          </p>
        </div>
      </header>

      <div className="catalog-legend">
        {(["K", "S", "T"] as const).map((e) => (
          <span key={e}>
            <span className={`evidence-badge evidence-${e}`}>{e}</span> {EVIDENCE_LABEL[e]}
          </span>
        ))}
        <span className="muted-text">
          {KPI_CATALOG_VERSION} · {KPI_ENGINE_VERSION}
        </span>
      </div>

      <div className="dashboard-tools catalog-tools">
        <label className="search-field">
          <span className="visually-hidden">Metrik ara</span>
          <AppIcon name="search" />
          <input type="search" placeholder="Metrik veya formül ara" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="catalog-toggle">
          <input type="checkbox" checked={onlyComputed} onChange={(e) => setOnlyComputed(e.target.checked)} />
          Yalnızca hesaplananlar
        </label>
      </div>

      {groups.map((g) => (
        <section className="team-section" key={g.key}>
          <h2 className="team-section-title">{g.title}</h2>
          <div className="multiplier-table-wrap">
            <table className="multiplier-table catalog-table">
              <thead>
                <tr>
                  <th>Metrik</th>
                  <th>Formül</th>
                  <th>Kanıt</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <strong>{k.name}</strong>
                      <small className="catalog-id">{k.id}</small>
                    </td>
                    <td className="catalog-formula">
                      <code>{k.formula}</code>
                      {k.decision && <small>Karar: {k.decision}</small>}
                    </td>
                    <td>
                      <EvidenceBadge def={k} />
                      {k.refs?.length ? (
                        <small className="catalog-refs">
                          <SourceLinks refs={k.refs} />
                        </small>
                      ) : null}
                    </td>
                    <td>
                      {k.computable ? (
                        <span className="catalog-status ok">Hesaplanıyor</span>
                      ) : (
                        <span className="catalog-status">Gerekli veri: {k.needs.map((n) => DATA_NEED_LABEL[n]).join(", ")}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="team-section">
        <h2 className="team-section-title">Platformun uyguladığı metodoloji kararları</h2>
        <dl className="catalog-decisions">
          {DECISIONS.map(([t, d]) => (
            <div key={t}>
              <dt>{t}</dt>
              <dd>{d}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="team-section">
        <h2 className="team-section-title">Kaynaklar</h2>
        <ol className="catalog-sources">
          {Object.entries(KPI_SOURCES).map(([n, s]) => (
            <li key={n} value={Number(n)}>
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>
              {s.note ? <small> ({s.note})</small> : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
