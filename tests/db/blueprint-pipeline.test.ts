/**
 * Drizzle Blueprint pipeline through the REAL AI SDK with a MOCK provider, on PGlite with every
 * migration. Replaces the removed Prisma llm-pipeline integration suite. Proves how the system
 * reacts to valid, schema-invalid and failing model output — not the real model's quality.
 */
import { and, eq, inArray } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiGenerations, eventKpis, events, proposals, surveys, tasks } from "@/db/schema";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";
import { coreExample, respondWith, TODAY, UNSUPPORTED_MARKERS, type MockState } from "./ai-mocks";

const h = vi.hoisted(() => ({ db: null as unknown, ai: { respond: () => "{}", calls: [] } as unknown as MockState }));
vi.mock("@/db", () => {
  class UnauthenticatedError extends Error {}
  return {
    UnauthenticatedError,
    getUserDb: async () => { throw new UnauthenticatedError("not used"); },
    adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
  };
});
vi.mock("@/server/ai/models", async (orig) => {
  const real = await orig<typeof import("@/server/ai/models")>();
  const { mockModel } = await import("./ai-mocks");
  // the provider key check is exercised separately; here the model is the mock
  return { ...real, modelFor: () => mockModel(h.ai), assertAiConfigured: () => {} };
});

const bp = await import("@/server/ai/blueprint-drizzle");
const { applyProposal, fingerprint } = await import("@/server/planning/apply-proposal-drizzle");
const { toApiProposalStatus, ProposalError } = await import("@/server/planning/proposal-error");
const { startGeneration } = await import("@/server/logistics/ai-generations-drizzle");
const ops = await import("@/lib/ai/blueprint/operations");

let ctx: Awaited<ReturnType<typeof setupDb>>;
type OrgAccess = import("@/server/auth/org-access").OrgAccess;
const orgA: OrgAccess = { userId: U.ownerA, organizationId: ORG_A, organizationName: "Adana Belediyesi", organizerType: "MUNICIPALITY", role: "owner" };
const orgB: OrgAccess = { userId: U.ownerB, organizationId: ORG_B, organizationName: "B", organizerType: "OTHER", role: "owner" };
let eventId = "";
let eventB = "";

const newGeneration = (org = orgA) =>
  startGeneration(org, { kind: "blueprint.core", prompt: "p", schemaVersion: "blueprint/v1", provider: "mock", model: "mock-model", temperature: 0 });
const gen = async (id: string) => (await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, id)))[0]!;
const proposalCount = async () => (await ctx.db.select({ id: proposals.id }).from(proposals)).length;

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  [{ id: eventB }] = await ctx.db.insert(events).values({ organizationId: ORG_B, title: "B etkinliği" }).returning({ id: events.id }) as [{ id: string }];
}, 60_000);

describe("Stage 1: core profile → proposal (never applied automatically)", () => {
  it("schema-invalid output: FAILED_VALIDATION, no proposal, no event", async () => {
    const g = await newGeneration();
    const bad = { ...(await coreExample()), proposedModules: [{ key: "launch_missiles", reason: "x" }] };
    const r = await bp.finalizeCoreGeneration({ org: orgA, generationId: g, today: TODAY, startedAt: Date.now(), output: async () => bad, usage: async () => ({}) });
    expect(r.status).toBe("FAILED_VALIDATION");
    expect(await ctx.db.select().from(proposals).where(eq(proposals.generationId, g))).toEqual([]);
    expect((await gen(g)).status).toBe("FAILED_VALIDATION");
  });

  it("provider failure: FAILED_PROVIDER, no proposal", async () => {
    const g = await newGeneration();
    const r = await bp.finalizeCoreGeneration({ org: orgA, generationId: g, today: TODAY, startedAt: Date.now(),
      output: async () => { throw new Error("overloaded"); }, usage: async () => ({}) });
    expect(r.status).toBe("FAILED_PROVIDER");
    expect(await ctx.db.select().from(proposals).where(eq(proposals.generationId, g))).toEqual([]);
    expect((await gen(g)).validationErrors).toMatchObject({ message: "overloaded", kind: "overloaded", attempts: [{ kind: "overloaded" }] });
  });

  it("provider failure with a working fallback: the fallback's output becomes the proposal, and that is recorded", async () => {
    const g = await newGeneration();
    const r = await bp.finalizeCoreGeneration({ org: orgA, generationId: g, today: TODAY, startedAt: Date.now(),
      output: async () => { throw new Error("No output generated. finishReason: length"); }, usage: async () => ({}),
      fallback: async () => ({ output: await coreExample(), usage: { inputTokens: 3, outputTokens: 4 } }) });
    expect(r.status).toBe("PROPOSED");
    expect((await gen(g))).toMatchObject({ status: "SUCCEEDED", inputTokens: 3, output: { fallback: { after: { kind: "truncated" } } } });
  });

  it("valid output: one PENDING proposal with full metadata; the event exists only after a person applies it", async () => {
    const before = (await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length;
    const g = await newGeneration();
    const r = await bp.finalizeCoreGeneration({ org: orgA, generationId: g, today: TODAY, startedAt: Date.now(),
      output: async () => coreExample(), usage: async () => ({ inputTokens: 1, outputTokens: 2 }) });
    expect(r.status).toBe("PROPOSED");
    const [p] = await ctx.db.select().from(proposals).where(eq(proposals.id, r.proposalId!));
    expect(p).toMatchObject({ status: "PENDING", organizationId: ORG_A, eventId: null, generationId: g, requestedBy: U.ownerA,
      kind: "blueprint.core", schemaVersion: "blueprint/v1", baseVersion: null });
    expect(p!.aiFingerprint).toBe(fingerprint(p!.payload));
    expect((p!.payload as { operations: unknown[] }).operations).toHaveLength(1);
    expect(p!.expiresAt.getTime() - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
    expect(await gen(g)).toMatchObject({ status: "SUCCEEDED", inputTokens: 1, outputTokens: 2, requestedBy: U.ownerA });
    expect((await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length).toBe(before);

    eventId = (await applyProposal({ proposalId: p!.id, organizationId: ORG_A, actorId: U.ownerA })).eventId;
    const [applied] = await ctx.db.select().from(proposals).where(eq(proposals.id, p!.id));
    expect(applied!.status).toBe("APPROVED");
    expect(toApiProposalStatus(applied!.status)).toBe("APPLIED");
    expect(await gen(g)).toMatchObject({ status: "APPLIED", eventId });
    expect((await ctx.db.select().from(events).where(eq(events.organizationId, ORG_A))).length).toBe(before + 1);
  });
});

describe("Stage 2: supported sections only", () => {
  it("default run: tasks/kpis/surveys proposals; registration and budget_risks reported unsupported and never generated", async () => {
    h.ai.calls.length = 0;
    h.ai.respond = respondWith();
    const status = await bp.runBlueprintSections({ org: orgA, eventId, today: TODAY });
    expect(status).toEqual({ tasks: "ok", kpis: "ok", surveys: "ok", registration: "unsupported", budget_risks: "unsupported" });
    for (const marker of UNSUPPORTED_MARKERS) expect(h.ai.calls.some((c) => c.system.includes(marker))).toBe(false);
    for (const c of h.ai.calls) {
      expect(c.temperature).toBe(0);
      expect(c.responseFormat).toMatchObject({ type: "json" });
      expect(c.responseFormat?.schema).toBeTruthy();
    }
    const cards = await ctx.db.select().from(proposals).where(and(eq(proposals.eventId, eventId), eq(proposals.status, "PENDING")));
    expect(cards.map((p) => p.kind).sort()).toEqual(["blueprint.kpis", "blueprint.surveys", "blueprint.tasks"]);
    const [ev] = await ctx.db.select().from(events).where(eq(events.id, eventId));
    for (const c of cards) {
      expect(c).toMatchObject({ organizationId: ORG_A, requestedBy: U.ownerA, baseVersion: ev!.updatedAt.toISOString() });
      expect(await gen(c.generationId!)).toMatchObject({ organizationId: ORG_A, eventId, kind: c.kind, status: "SUCCEEDED", requestedBy: U.ownerA });
    }
    const gens = await ctx.db.select({ kind: aiGenerations.kind }).from(aiGenerations).where(eq(aiGenerations.eventId, eventId));
    expect(gens.map((g) => g.kind).filter((k) => k !== "blueprint.core").sort()).toEqual(["blueprint.kpis", "blueprint.surveys", "blueprint.tasks"]);
    expect(cards.find((c) => c.kind === "blueprint.kpis")!.rationale).toMatch(/literatür incelemesinden geçmedi/);
    // nothing written to domain tables before a person applies
    expect(await ctx.db.select().from(tasks).where(eq(tasks.eventId, eventId))).toEqual([]);
    expect(await ctx.db.select().from(eventKpis).where(eq(eventKpis.eventId, eventId))).toEqual([]);
  });

  it("the section cards apply end to end: rows written, DB APPROVED / API APPLIED, generations APPLIED", async () => {
    const cards = await ctx.db.select().from(proposals).where(and(eq(proposals.eventId, eventId), eq(proposals.status, "PENDING")));
    for (const kind of ["blueprint.tasks", "blueprint.kpis", "blueprint.surveys"]) {
      const c = cards.find((x) => x.kind === kind)!;
      await applyProposal({ proposalId: c.id, organizationId: ORG_A, actorId: U.ownerA });
      const [after] = await ctx.db.select().from(proposals).where(eq(proposals.id, c.id));
      expect(toApiProposalStatus(after!.status)).toBe("APPLIED");
      expect((await gen(c.generationId!)).status).toBe("APPLIED");
    }
    expect((await ctx.db.select().from(tasks).where(and(eq(tasks.eventId, eventId), eq(tasks.blueprintKey, "permits")))).length).toBe(1);
    expect((await ctx.db.select().from(eventKpis).where(and(eq(eventKpis.eventId, eventId), eq(eventKpis.metricName, "overall_satisfaction"))))[0])
      .toMatchObject({ dataSource: "survey", status: "PROPOSED" });
    expect((await ctx.db.select().from(surveys).where(eq(surveys.eventId, eventId)))[0]).toMatchObject({ title: "Festival anketi", intro: "Kısa anket.", status: "DRAFT" });
  });

  it("naming an unsupported section explicitly is INVALID before any model call or write", async () => {
    h.ai.calls.length = 0;
    const gensBefore = (await ctx.db.select().from(aiGenerations)).length;
    for (const sections of [["registration"], ["tasks", "budget_risks"]] as const) {
      await expect(bp.runBlueprintSections({ org: orgA, eventId, today: TODAY }, sections))
        .rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/Desteklenmeyen bölüm/) });
    }
    expect(h.ai.calls).toHaveLength(0);
    expect((await ctx.db.select().from(aiGenerations)).length).toBe(gensBefore);
  });

  it("an explicit selection reports only what was asked", async () => {
    h.ai.respond = respondWith();
    expect(await bp.runBlueprintSections({ org: orgA, eventId, today: TODAY }, ["tasks"])).toEqual({ tasks: "ok" });
  });

  it("schema-invalid section output fails only that section (FAILED_VALIDATION); others still propose", async () => {
    await ctx.db.delete(proposals).where(and(eq(proposals.eventId, eventId), eq(proposals.status, "PENDING")));
    h.ai.respond = respondWith({ "Produce the task plan": JSON.stringify({ assumptions: [], tasks: [{ key: "x", title: "y", workstream: "not_a_workstream" }] }) });
    const status = await bp.runBlueprintSections({ org: orgA, eventId, today: TODAY });
    expect(status.tasks).not.toBe("ok");
    expect(status.kpis).toBe("ok");
    const kinds = (await ctx.db.select().from(proposals).where(and(eq(proposals.eventId, eventId), eq(proposals.status, "PENDING")))).map((p) => p.kind).sort();
    expect(kinds).toEqual(["blueprint.kpis", "blueprint.surveys"]);
    expect((await ctx.db.select().from(aiGenerations)
      .where(and(eq(aiGenerations.eventId, eventId), eq(aiGenerations.kind, "blueprint.tasks"), eq(aiGenerations.status, "FAILED_VALIDATION")))).length).toBe(1);
  });

  it("provider errors are recorded as FAILED_PROVIDER and surface in the section status", async () => {
    h.ai.respond = respondWith({ "Select KPIs": new Error("529 overloaded") });
    const status = await bp.runBlueprintSections({ org: orgA, eventId, today: TODAY }, ["kpis"]);
    expect(status.kpis).toMatch(/overloaded/);
    expect((await ctx.db.select().from(aiGenerations)
      .where(and(eq(aiGenerations.eventId, eventId), eq(aiGenerations.kind, "blueprint.kpis"), eq(aiGenerations.status, "FAILED_PROVIDER")))).length).toBe(1);
  });

  it("another organization cannot run sections on this event", async () => {
    await expect(bp.runBlueprintSections({ org: orgB, eventId, today: TODAY })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(bp.loadApprovedCore(ORG_B, eventId)).rejects.toBeInstanceOf(ProposalError);
  });
});

describe("saveProposal: only valid, supported, same-organization proposals are stored", () => {
  it("refuses unsupported operations (registration, budget/risk) and stores nothing", async () => {
    const g = await newGeneration();
    const n = await proposalCount();
    const reg = ops.registrationProposal([{ key: "genel", name: "Genel", description: null, pricing: "FREE", priceAmountMinor: null, currency: "TRY",
      quantity: null, maxPerOrder: 4, requiresApproval: false, eligibility: null, validDayIndexes: [], sortOrder: 0 }], [], []);
    await expect(bp.saveProposal({ org: orgA, eventId, today: TODAY }, g, reg)).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/ticket_type/) });
    const br = ops.budgetRisksProposal([{ key: "stage", direction: "EXPENSE", category: "stage_production", label: "Sahne", plannedAmountMinor: null, notes: null }], [], []);
    await expect(bp.saveProposal({ org: orgA, eventId, today: TODAY }, g, br)).rejects.toMatchObject({ code: "INVALID", message: expect.stringMatching(/budget_line/) });
    const patch = { kind: "copilot.update_task", title: "t", rationale: null,
      operations: [{ op: "update" as const, entity: "task_patch" as const, id: "0e000000-0000-4000-8000-000000000001", patch: { status: "BLOCKED" as const } }] };
    await expect(bp.saveProposal({ org: orgA, eventId, today: TODAY }, g, patch)).rejects.toMatchObject({ code: "INVALID" });
    expect(await proposalCount()).toBe(n);
  });

  it("refuses operations that fail the Zod contract and stores nothing", async () => {
    const g = await newGeneration();
    const n = await proposalCount();
    const bad = { kind: "blueprint.tasks", title: "t", rationale: null, operations: [{ op: "upsert", entity: "task", data: { key: "DROP TABLE" } }] };
    await expect(bp.saveProposal({ org: orgA, eventId, today: TODAY }, g, bad as never)).rejects.toMatchObject({ name: "ZodError" });
    await expect(bp.saveProposal({ org: orgA, eventId, today: TODAY }, g, { ...bad, operations: [] } as never)).rejects.toMatchObject({ name: "ZodError" });
    expect(await proposalCount()).toBe(n);
  });

  it("refuses another organization's event (NOT_FOUND) or generation (composite FK) and stores nothing", async () => {
    const n = await proposalCount();
    const draft = ops.kpisProposal([{ metricKey: "nps", objectiveIndex: null, target: null, targetBasis: null, rationale: "r" }], []);
    await expect(bp.saveProposal({ org: orgA, eventId: eventB, today: TODAY }, await newGeneration(), draft)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const genB = await newGeneration(orgB);
    expect(await outcome(bp.saveProposal({ org: orgA, eventId, today: TODAY }, genB, draft))).toMatch(/proposals_generation_same_org_fk/);
    expect(await proposalCount()).toBe(n);
    expect(await ctx.db.select().from(proposals).where(inArray(proposals.generationId, [genB]))).toEqual([]);
  });
});
