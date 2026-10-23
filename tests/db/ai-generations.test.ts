/**
 * Drizzle ai-generations data access (port step 4): src/server/logistics/ai-generations-drizzle.ts
 * against real PostgreSQL (PGlite) with the 0000–0004 migrations, RLS and grants.
 * `@/db` is mocked so the module's `adminDb` is the migrated PGlite database (RLS-bypassing, like prod).
 */
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { aiGenerations, events } from "@/db/schema";
import { ORG_A, ORG_B, outcome, setupDb, U } from "./helpers";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({
  // Forward every property to the PGlite database created in beforeAll.
  adminDb: new Proxy({}, { get: (_t, p) => { const db = h.db as Record<string | symbol, unknown>; const v = db[p]; return typeof v === "function" ? v.bind(db) : v; } }),
}));

const gens = await import("@/server/logistics/ai-generations-drizzle");
const { startGeneration, finishGeneration, markGenerationApplied, findAppliedCoreOutput, GenerationNotFoundError } = gens;

let ctx: Awaited<ReturnType<typeof setupDb>>;
let eventA: string;
let eventB: string;
const scopeA = { organizationId: ORG_A, userId: U.ownerA };
const scopeB = { organizationId: ORG_B, userId: U.ownerB };
const rec = { kind: "blueprint.core", prompt: "İstanbul'da 2 günlük teknoloji konferansı", schemaVersion: "blueprint.core@1",
  provider: "anthropic", model: "claude-test", temperature: 0.3 };

const row = async (id: string) => (await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.id, id)))[0]!;

beforeAll(async () => {
  ctx = await setupDb();
  h.db = ctx.db;
  [{ id: eventA }] = await ctx.db.insert(events).values({ organizationId: ORG_A, title: "Etkinlik A" }).returning({ id: events.id }) as [{ id: string }];
  [{ id: eventB }] = await ctx.db.insert(events).values({ organizationId: ORG_B, title: "Etkinlik B" }).returning({ id: events.id }) as [{ id: string }];
}, 60_000);

describe("startGeneration", () => {
  it("creates a STREAMING generation owned by the verified organization and user", async () => {
    const id = await startGeneration(scopeA, { ...rec, eventId: eventA, baseConfig: { event: { title: "x" } } });
    expect(await row(id)).toMatchObject({
      organizationId: ORG_A, requestedBy: U.ownerA, eventId: eventA, kind: "blueprint.core", prompt: rec.prompt,
      baseConfig: { event: { title: "x" } }, schemaVersion: "blueprint.core@1", provider: "anthropic", model: "claude-test",
      temperature: "0.30", status: "STREAMING", output: null, validationErrors: null, latencyMs: null,
    });
  });

  it("stores SQL NULL (not JSON null) when there is no baseConfig or eventId", async () => {
    const id = await startGeneration(scopeA, rec);
    expect(await row(id)).toMatchObject({ eventId: null, baseConfig: null });
    const [r] = (await ctx.pg.query<{ n: boolean }>("select base_config is null as n from ai_generations where id = $1", [id])).rows;
    expect(r!.n).toBe(true);
  });

  it("rejects missing/invalid required fields (DB constraints)", async () => {
    expect(await outcome(startGeneration(scopeA, { ...rec, kind: "Blueprint Core" }))).toMatch(/ai_generations_kind_format/);
    expect(await outcome(startGeneration(scopeA, { ...rec, kind: "blueprint.core.extra" }))).toMatch(/ai_generations_kind_format/);
    expect(await outcome(startGeneration(scopeA, { ...rec, schemaVersion: "  " }))).toMatch(/ai_generations_schema_version_not_blank/);
    expect(await outcome(startGeneration(scopeA, { ...rec, temperature: 2.5 }))).toMatch(/ai_generations_temperature_range|numeric field overflow/);
    expect(await outcome(startGeneration(scopeA, { ...rec, temperature: -0.1 }))).toMatch(/ai_generations_temperature_range/);
    expect(await outcome(startGeneration(scopeA, { ...rec, prompt: null as unknown as string }))).toMatch(/null value in column "prompt"/);
    expect(await outcome(startGeneration(scopeA, { ...rec, model: undefined as unknown as string }))).toMatch(/null value in column "model"|default/);
  });

  it("rejects an invalid organization reference", async () => {
    // unknown organization
    expect(await outcome(startGeneration({ organizationId: "0c000000-0000-4000-8000-00000000000c", userId: U.ownerA }, rec)))
      .toMatch(/foreign key/);
    // event of another organization
    expect(await outcome(startGeneration(scopeA, { ...rec, eventId: eventB }))).toMatch(/ai_generations_event_same_org_fk/);
    // user of another organization claimed as requester
    expect(await outcome(startGeneration({ organizationId: ORG_A, userId: U.ownerB }, rec))).toMatch(/ai_generations_requested_by_same_org_fk/);
    expect(await ctx.db.select().from(aiGenerations).where(eq(aiGenerations.requestedBy, U.ownerB))).toEqual([]);
  });

  it("accepts every kind the app uses", async () => {
    for (const kind of ["event_config", "event_config_patch", "copilot", "blueprint.core", "blueprint.tasks", "blueprint.kpis",
      "blueprint.surveys", "blueprint.budget_risks", "blueprint.registration"]) {
      expect((await row(await startGeneration(scopeA, { ...rec, kind }))).kind).toBe(kind);
    }
  });
});

describe("finishGeneration", () => {
  it("SUCCEEDED stores output, tokens and latency", async () => {
    const id = await startGeneration(scopeA, rec);
    await finishGeneration(scopeA, id, { status: "SUCCEEDED", output: { draft: { a: 1 } }, inputTokens: 120, outputTokens: 450, latencyMs: 900 });
    expect(await row(id)).toMatchObject({ status: "SUCCEEDED", output: { draft: { a: 1 } }, validationErrors: null,
      inputTokens: 120, outputTokens: 450, latencyMs: 900 });
  });

  it("FAILED_VALIDATION stores raw output and errors; FAILED_PROVIDER without output stores NULL output", async () => {
    const v = await startGeneration(scopeA, rec);
    await finishGeneration(scopeA, v, { status: "FAILED_VALIDATION", output: { text: "{bozuk" }, errors: { formErrors: ["x"] }, latencyMs: 10 });
    expect(await row(v)).toMatchObject({ status: "FAILED_VALIDATION", output: { text: "{bozuk" }, validationErrors: { formErrors: ["x"] }, latencyMs: 10 });

    const p = await startGeneration(scopeA, rec);
    await finishGeneration(scopeA, p, { status: "FAILED_PROVIDER", errors: { message: "timeout" }, latencyMs: 30_000 });
    expect(await row(p)).toMatchObject({ status: "FAILED_PROVIDER", output: null, validationErrors: { message: "timeout" }, inputTokens: null });
  });

  it("omitted token counts leave existing values unchanged (Prisma parity)", async () => {
    const id = await startGeneration(scopeA, rec);
    await ctx.db.update(aiGenerations).set({ inputTokens: 7 }).where(eq(aiGenerations.id, id));
    await finishGeneration(scopeA, id, { status: "SUCCEEDED", output: {}, latencyMs: 1 });
    expect((await row(id)).inputTokens).toBe(7);
  });

  it("cannot touch another organization's generation (not found, row unchanged)", async () => {
    const idB = await startGeneration(scopeB, { ...rec, eventId: eventB });
    await expect(finishGeneration(scopeA, idB, { status: "SUCCEEDED", output: { hijack: true }, latencyMs: 1 }))
      .rejects.toBeInstanceOf(GenerationNotFoundError);
    expect(await row(idB)).toMatchObject({ organizationId: ORG_B, status: "STREAMING", output: null });
  });

  it("unknown id throws GenerationNotFoundError (Prisma update also threw)", async () => {
    await expect(finishGeneration(scopeA, "0d000000-0000-4000-8000-00000000000d", { status: "SUCCEEDED", output: {}, latencyMs: 1 }))
      .rejects.toBeInstanceOf(GenerationNotFoundError);
  });

  it("an unknown status is rejected by the enum", async () => {
    const id = await startGeneration(scopeA, rec);
    expect(await outcome(finishGeneration(scopeA, id, { status: "DONE" as "SUCCEEDED", output: {}, latencyMs: 1 })))
      .toMatch(/invalid input value for enum ai_generation_status/);
    expect((await row(id)).status).toBe("STREAMING");
  });
});

describe("markGenerationApplied / findAppliedCoreOutput", () => {
  it("marks APPLIED and links the event; the latest applied core output is returned", async () => {
    const g1 = await startGeneration(scopeA, rec);
    await finishGeneration(scopeA, g1, { status: "SUCCEEDED", output: { draft: { event: { v: 1 } } }, latencyMs: 1 });
    await markGenerationApplied(ctx.db, ORG_A, g1, eventA);
    expect(await row(g1)).toMatchObject({ status: "APPLIED", eventId: eventA });

    const g2 = await startGeneration(scopeA, rec);
    await finishGeneration(scopeA, g2, { status: "SUCCEEDED", output: { draft: { event: { v: 2 } } }, latencyMs: 1 });
    await ctx.db.update(aiGenerations).set({ createdAt: sql`now() + interval '1 minute'` }).where(eq(aiGenerations.id, g2));
    expect(await findAppliedCoreOutput(ORG_A, eventA)).toEqual({ draft: { event: { v: 1 } } }); // g2 not applied yet
    await markGenerationApplied(ctx.db, ORG_A, g2, eventA);
    expect(await findAppliedCoreOutput(ORG_A, eventA)).toEqual({ draft: { event: { v: 2 } } });
  });

  it("is organization-scoped: no cross-tenant apply or read", async () => {
    const idB = await startGeneration(scopeB, rec);
    await expect(markGenerationApplied(ctx.db, ORG_A, idB, eventA)).rejects.toBeInstanceOf(GenerationNotFoundError);
    // even the right org cannot link another org's event (composite FK)
    expect(await outcome(markGenerationApplied(ctx.db, ORG_B, idB, eventA))).toMatch(/ai_generations_event_same_org_fk/);
    await finishGeneration(scopeB, idB, { status: "SUCCEEDED", output: { draft: { event: { org: "B" } } }, latencyMs: 1 });
    await markGenerationApplied(ctx.db, ORG_B, idB, eventB);
    expect(await findAppliedCoreOutput(ORG_B, eventB)).toEqual({ draft: { event: { org: "B" } } });
    expect(await findAppliedCoreOutput(ORG_A, eventB)).toBeNull();
  });

  it("rolls back with the surrounding transaction", async () => {
    const id = await startGeneration(scopeA, rec);
    await expect(ctx.db.transaction(async (tx) => {
      await markGenerationApplied(tx, ORG_A, id, eventA);
      throw new Error("apply failed later");
    })).rejects.toThrow("apply failed later");
    expect(await row(id)).toMatchObject({ status: "STREAMING", eventId: null });
  });
});

describe("RLS: tenant reads, no client writes", () => {
  it("A's generations are invisible to B and B's to A; staff of A can read A's", async () => {
    const idA = await startGeneration(scopeA, rec);
    const idB = await startGeneration(scopeB, rec);
    const seen = (u: string) => ctx.as(u, (tx) => tx.select({ id: aiGenerations.id, org: aiGenerations.organizationId }).from(aiGenerations));
    const a = await seen(U.ownerA), b = await seen(U.ownerB), s = await seen(U.staffA), none = await seen(U.noProfile);
    expect(a.every((r) => r.org === ORG_A) && a.some((r) => r.id === idA) && !a.some((r) => r.id === idB)).toBe(true);
    expect(b.every((r) => r.org === ORG_B) && b.some((r) => r.id === idB) && !b.some((r) => r.id === idA)).toBe(true);
    expect(s.some((r) => r.id === idA)).toBe(true);
    expect(none).toEqual([]);
    // direct lookup of B's id with A's session finds nothing
    expect(await ctx.as(U.ownerA, (tx) => tx.select().from(aiGenerations).where(eq(aiGenerations.id, idB)))).toEqual([]);
  });

  it("clients cannot insert, update or delete generations, even in their own organization", async () => {
    const idA = await startGeneration(scopeA, rec);
    for (const u of [U.ownerA, U.staffA]) {
      expect(await outcome(ctx.as(u, (tx) => tx.insert(aiGenerations).values({ organizationId: ORG_A, requestedBy: u, ...rec, temperature: "0.3" }))))
        .toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.update(aiGenerations).set({ status: "APPLIED" }).where(eq(aiGenerations.id, idA)))))
        .toMatch(/permission denied/);
      expect(await outcome(ctx.as(u, (tx) => tx.delete(aiGenerations).where(and(eq(aiGenerations.id, idA))))))
        .toMatch(/permission denied/);
    }
    expect((await row(idA)).status).toBe("STREAMING");
  });
});
