/**
 * src/db/index.ts must not touch the database (or require DATABASE_URL) at import time: `next build`
 * imports every route module to collect its config. The connection is created on first use, and a
 * missing DATABASE_URL is reported then, with a clear message.
 * No real database is involved: 127.0.0.1:1 is a closed port, so a query attempt fails immediately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "@/db/schema";

const created: unknown[][] = [];
vi.mock("postgres", async () => {
  const real = await vi.importActual<{ default: (...a: unknown[]) => unknown }>("postgres");
  const wrapped = (...args: unknown[]) => {
    created.push(args);
    return real.default(...args);
  };
  return { ...real, default: wrapped };
});

const ORIGINAL = process.env.DATABASE_URL;
beforeEach(() => {
  created.length = 0;
  delete (globalThis as { pgClient?: unknown }).pgClient;
  vi.resetModules();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = ORIGINAL;
});

describe("without DATABASE_URL", () => {
  it("imports fine (no throw, no client) and the first use fails with a clear configuration error", async () => {
    delete process.env.DATABASE_URL;
    const mod = await import("@/db");
    expect(created).toHaveLength(0);
    await expect((async () => mod.adminDb.select().from(events))()).rejects.toThrow(/^DATABASE_URL is not set/);
    await expect((async () => mod.adminDb.transaction(async () => 1))()).rejects.toThrow(mod.MISSING_DATABASE_URL);
    expect(created).toHaveLength(0);
  });

  it("the service modules that import adminDb load without it too", async () => {
    delete process.env.DATABASE_URL;
    await expect(import("@/server/planning/apply-proposal-drizzle")).resolves.toBeDefined();
    await expect(import("@/server/ai/blueprint-drizzle")).resolves.toBeDefined();
    await expect(import("@/server/logistics/ai-generations-drizzle")).resolves.toBeDefined();
    expect(created).toHaveLength(0);
  });
});

describe("with DATABASE_URL", () => {
  it("creates one client on first use (Supavisor options), reuses it, and connects only when a query runs", async () => {
    process.env.DATABASE_URL = "postgres://u:p@127.0.0.1:1/none";
    const { adminDb } = await import("@/db");
    expect(created).toHaveLength(0); // import: nothing created

    const q = adminDb.select().from(events); // building a query creates the client, no I/O yet
    expect(created).toHaveLength(1);
    expect(created[0]![0]).toBe("postgres://u:p@127.0.0.1:1/none");
    expect(created[0]![1]).toMatchObject({ prepare: false, connect_timeout: 10 });
    adminDb.select();
    expect(created).toHaveLength(1);

    // Executing is the first network access: the closed port refuses it.
    await expect(q).rejects.toMatchObject({ cause: expect.objectContaining({ code: "ECONNREFUSED" }) });
    await (globalThis as { pgClient?: { end: (o: object) => Promise<void> } }).pgClient?.end({ timeout: 0 });
  });
});
