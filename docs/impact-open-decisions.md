# Impact & metrics — open decisions

Status: the impact calculation works end to end (survey responses → sourced inputs → stored, immutable
runs; migration 0007). The code still contains **no coefficient, multiplier or threshold of its own**:
the arithmetic is the metric library's formulas (`src/lib/metrics/library.ts`), and every number that
scales a result is an input the organization records with its source. What exists:

- `src/lib/impact/sufficiency.ts` — the data-sufficiency gate (which level may be reported, and why not).
- `src/lib/impact/engine.ts` — the calculation on top of the gate (see its header for the formulas).
- `GET /api/events/:eventId/impact` — readiness on live data, no figure; `POST …/impact/runs` — stores a run.
- `METRIC_LIBRARY` — `minSampleSize` values are still **unreviewed placeholders** (each check note says so).

Each item below is a methodology decision. The column on the right is what the code does until it is made.

| # | Decision | Where it is used | Current behaviour until decided |
|---|---|---|---|
| 1 | Minimum sample sizes per metric (`minSampleSize`) | gate (SPEND 150, ATTRIBUTABLE_SPEND 200) | placeholder values, flagged as unreviewed in every check |
| 2 | Survey responses: storage, consent/KVKK, exclusion rules, "non-resident" definition, weighting | `survey_responses`, engine | stored **anonymously** (no identity → no consent record; sensitive questions need an explicit consent flag); non-resident = the respondent's own answer `q_is_local = false`; exclusion is **manual** (owner/admin, with a reason), no automatic rules; every weight = 1 |
| 3 | Attendance basis and its order: check-ins → issued tickets → organizer estimate | engine input | that order; an organizer estimate never passes the ATTRIBUTABLE_SPEND check (gate rule) |
| 4 | Deadweight, displacement, leakage: allowed sources, who records them, per event or per region | `event_impact_inputs` | **Decided (Oct 2026, engine 2.0.0, KPI reference §3.10 and §4.1–4.2):** attributable spend is **measured from the attendee survey** by default — strict rule (non-resident, main reason = the event, would not have come otherwise; no partial credit), applied per spend category; the broad rule ("event and other", "maybe") is reported only as a sensitivity bound. A sourced deadweight rate remains selectable (`RECORDED_DEADWEIGHT`). Displacement and leakage stay **parameters** recorded per event by owner/admin with a source (no official defaults are built in: the document could not verify eventIMPACTS' values). With a TÜİK set, leakage should cover only spending that leaves the region (imports and taxes are already removed). Not yet: a survey question measuring displacement, and organizer local spend in the net direct injection (needs budget data, phase 3) |
| 5 | Multiplier sets: source, regional (NUTS-2) vs national, versioning, who activates one | `multiplier_sets`, `multipliers` | entered by the organization with a citation, **or computed from TÜİK's 2023 input-output tables** (`src/lib/io`, `POST /api/multiplier-sets/from-io`): Type I, A64 domestic use table → L = (I − A)⁻¹; purchasers' → basic price bridge from TÜİK's household column (trade/transport margins, net product taxes and imports removed); national, or FLQ-regionalised with the region's A10 activity and a δ the organization enters **with sources** (the system supplies neither). The tables carry no employment, so these sets have no employment coefficient and no employment figure is reported. Because imports and taxes are already removed, the event's leakage input should then cover only spending that leaves the region. A national set never qualifies for a regional impact (gate); coefficients are never edited — a new set is recorded |
| 6 | Price year / currency handling (TRY, inflation adjustment) | inputs `priceYear`, set `priceYear` | **Decided (Oct 2026):** output, value-added and income multipliers are ratios per TRY of demand and are applied to spend of any price year (the input-output model's fixed technical coefficients — so a TÜİK 2023 set is used on 2026 spend). Employment per million TRY depends on the price level: it is reported only when both price years are equal, otherwise the run has no employment figure (check `price_years_match`, informational). No deflation of spend |
| 7 | Where computed runs are stored and how a report cites them | `impact_calculation_runs` | stored immutably with checks, inputs and figures; a report cites the run id. Report narratives (LLM) are not built |
| 8 | When an event may be assessed: required status (`completed`?) and allowed status transitions (O2) | events PATCH accepts any status change | runs are allowed in any event status |
| 9 | KPI `actual_value`: computed from which source per `data_source` (survey / ticket_sales / system) | `event_kpis` | **Decided (Oct 2026):** the KPI engine (`src/lib/kpi`, formulas from "Etkinlik Etki Analizi — KPI ve Formül Referansı (Kaynaklı)") computes every metric the platform has data for, on read; other KPIs take a manual actual (`PATCH /api/kpis/:id { actualValue }`), refused for computed ones |
| 10 | Uncertainty: confidence intervals / bootstrap, trimming rule | engine | 1st/99th percentile trimming (library formula); no confidence interval is produced |

Not decided here and tracked elsewhere: B1 (`supabase_admin` default privileges — moot on plain PostgreSQL), O3 (anon SELECT),
O5/O6/O7/O10 (migration operations: lock timeout/concurrency, SSL, migration hash check, version
pinning). These come from the 0006 review and are not yet written up in this repository. Public survey
links have no rate limit yet.
