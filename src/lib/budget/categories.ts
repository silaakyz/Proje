/**
 * Event budget lines (budget_items): what the finance metrics of the KPI reference (§3.4) and the organizer side of
 * the net injection (§3.10) are computed from. Amounts are kuruş; a line has a planned amount, an actual amount, or
 * both. Finance metrics use actual amounts only; the budget page compares them with the plan.
 *
 *   INCOME              money the organizer receives (tickets net of refunds and discounts, sponsorship, stands, …)
 *   COST                the organizer's costs; FIXED / VARIABLE drives the break-even point
 *   TICKET_ADJUSTMENT   refunds and discounts given on tickets — not income or cost, only for refund / discount rates
 *                       (gross ticket revenue = net ticket income + refunds + discounts)
 */
export const BUDGET_KINDS = ["INCOME", "COST", "TICKET_ADJUSTMENT"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export const BUDGET_CATEGORIES = {
  INCOME: ["TICKETS", "SPONSORSHIP", "EXHIBITOR", "GRANT", "MERCHANDISE", "OTHER"],
  COST: ["VENUE", "PRODUCTION", "CATERING", "MARKETING", "STAFF", "SECURITY", "LOGISTICS", "ARTISTS_SPEAKERS", "PERMITS_INSURANCE", "LEAD_PROGRAM", "OTHER"],
  TICKET_ADJUSTMENT: ["REFUND", "DISCOUNT"],
} as const satisfies Record<BudgetKind, readonly string[]>;
export type BudgetCategory = (typeof BUDGET_CATEGORIES)[BudgetKind][number];

export const COST_BEHAVIORS = ["FIXED", "VARIABLE"] as const;
export type CostBehavior = (typeof COST_BEHAVIORS)[number];

export const BUDGET_KIND_LABEL: Record<BudgetKind, string> = {
  INCOME: "Gelir",
  COST: "Gider",
  TICKET_ADJUSTMENT: "Bilet iadesi / indirimi",
};

export const BUDGET_CATEGORY_LABEL: Record<BudgetKind, Record<string, string>> = {
  INCOME: {
    TICKETS: "Bilet satışı (net)",
    SPONSORSHIP: "Sponsorluk",
    EXHIBITOR: "Stant / katılımcı firma",
    GRANT: "Hibe / destek",
    MERCHANDISE: "Ürün satışı",
    OTHER: "Diğer gelir",
  },
  COST: {
    VENUE: "Mekân",
    PRODUCTION: "Sahne, ses, ışık, teknik",
    CATERING: "Yiyecek-içecek",
    MARKETING: "Pazarlama ve tanıtım",
    STAFF: "Personel",
    SECURITY: "Güvenlik ve sağlık",
    LOGISTICS: "Lojistik ve ulaşım",
    ARTISTS_SPEAKERS: "Sanatçı / konuşmacı",
    PERMITS_INSURANCE: "İzin, sigorta",
    LEAD_PROGRAM: "Lead / iş geliştirme programı",
    OTHER: "Diğer gider",
  },
  TICKET_ADJUSTMENT: {
    REFUND: "İade",
    DISCOUNT: "İndirim",
  },
};

export const COST_BEHAVIOR_LABEL: Record<CostBehavior, string> = { FIXED: "Sabit", VARIABLE: "Değişken" };

/** Largest amount a line may carry: 100 billion TRY in kuruş. */
export const MAX_BUDGET_KURUS = 10_000_000_000_000;
