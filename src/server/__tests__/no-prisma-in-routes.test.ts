/**
 * Prisma is removed: the project is Drizzle-only. No Route Handler may reach Prisma, directly or through
 * any module it imports (static, re-export, dynamic or type-only imports); no source or test file imports
 * a Prisma package or a generated client; package.json declares no Prisma package or script; the Prisma
 * files are gone. Static analysis of the source, so it needs neither a database nor network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../..");
const ROOT = path.resolve(SRC, "..");

/** The former Prisma client module and legacy Prisma-backed services (deleted; must not come back). */
const FORBIDDEN_FILES = [
  "src/server/db.ts",
  "src/server/planning/apply-proposal.ts",
  "src/server/ai/blueprint.ts",
  "src/server/logistics/ai-generations.ts",
  "src/server/auth/require-org-role.ts",
];
const isForbiddenPackage = (spec: string) => spec === "prisma" || spec.startsWith("prisma/") || spec.startsWith("@prisma/");
const isGenerated = (rel: string) => rel.startsWith("src/generated/");
const isForbiddenFile = (r: string) => FORBIDDEN_FILES.includes(r) || isGenerated(r);

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts")])
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  // unresolved local import (e.g. the generated client when it has not been generated): keep the path
  return `${base}.ts`;
}

/**
 * Every module reachable from `entry`, with the import chain that reached it. A forbidden module (legacy
 * Prisma service or generated client) is recorded where it is first reached but not walked into: reaching it
 * is already the violation, and the result must not depend on whether that file happens to exist on disk
 * (a generated client left behind locally would otherwise add one entry per generated sub-module).
 */
function graph(entry: string) {
  const files = new Map<string, string[]>([[entry, [entry]]]);
  const packages = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (!fs.existsSync(file)) continue;
    const chain = files.get(file)!;
    for (const m of fs.readFileSync(file, "utf8").matchAll(IMPORT_RE)) {
      const spec = (m[1] ?? m[2])!;
      const target = resolve(file, spec);
      if (target === null) {
        if (!packages.has(spec)) packages.set(spec, [...chain, spec]);
        continue;
      }
      if (!files.has(target)) {
        files.set(target, [...chain, target]);
        if (!isForbiddenFile(rel(target))) queue.push(target);
      }
    }
  }
  return { files, packages };
}

const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
function routes(dir = path.join(SRC, "app")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? routes(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []);
}
function violations(entry: string): string[] {
  const { files, packages } = graph(entry);
  const out: string[] = [];
  for (const [file, chain] of files) {
    const r = rel(file);
    if (isForbiddenFile(r)) out.push(chain.map(rel).join(" -> "));
  }
  for (const [spec, chain] of packages) if (isForbiddenPackage(spec)) out.push([...chain.slice(0, -1).map(rel), spec].join(" -> "));
  return out;
}

describe("no Prisma in the active API", () => {
  const all = routes();

  it("finds the route handlers", () => {
    expect(all.length).toBeGreaterThanOrEqual(19);
  });

  it.each(all.map((f) => [rel(f), f]))("%s reaches no Prisma module, generated client or legacy service", (_name, file) => {
    expect(violations(file)).toEqual([]);
  });

  it("the analysis is not vacuous: it follows @/ and relative imports and sees the Drizzle stack", () => {
    const { files, packages } = graph(path.join(SRC, "app/api/proposals/[proposalId]/route.ts"));
    const reached = [...files.keys()].map(rel);
    expect(reached).toContain("src/server/http.ts");
    expect(reached).toContain("src/server/planning/apply-proposal-drizzle.ts");
    expect(reached).toContain("src/db/schema.ts");
    expect([...packages.keys()]).toContain("drizzle-orm");
  });

  it("control: a Prisma import is detected, directly and through a local module", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-prisma-"));
    try {
      fs.writeFileSync(path.join(dir, "client.ts"), `import { PrismaClient } from "@prisma/client";\nexport const db = new PrismaClient();\n`);
      fs.writeFileSync(path.join(dir, "route.ts"), `import { db } from "./client";\nexport const GET = () => db;\n`);
      fs.writeFileSync(path.join(dir, "gen.ts"), `export type { X } from "@/generated/prisma/client";\n`);
      expect(violations(path.join(dir, "route.ts"))).toEqual([expect.stringMatching(/route\.ts -> .*client\.ts -> @prisma\/client$/)]);
      expect(violations(path.join(dir, "gen.ts"))).toEqual([expect.stringMatching(/src\/generated\/prisma\/client\.ts$/)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Prisma is removed from the project", () => {
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(ts|tsx|mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []);

  it("no source, test or script file imports a Prisma package or a generated client", () => {
    // This file itself is skipped: its control fixtures contain Prisma import strings on purpose.
    const offenders = ["src", "tests", "scripts"].flatMap((d) => sources(path.join(ROOT, d))).filter((f) => path.resolve(f) !== path.resolve(__filename)).flatMap((f) =>
      [...fs.readFileSync(f, "utf8").matchAll(IMPORT_RE)]
        .map((m) => (m[1] ?? m[2])!)
        .filter((spec) => isForbiddenPackage(spec) || spec.startsWith("@/generated/"))
        .map((spec) => `${rel(f)}: ${spec}`));
    expect(offenders).toEqual([]);
  });

  it("package.json has no Prisma dependency or script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as Record<string, Record<string, string>>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies });
    expect(deps.filter((d) => isForbiddenPackage(d) || d.includes("prisma"))).toEqual([]);
    expect(Object.entries(pkg.scripts ?? {}).filter(([, cmd]) => /\bprisma\b/.test(cmd))).toEqual([]);
  });

  it("the Prisma schema, migrations, config, generated client and legacy services are gone", () => {
    const left = ["prisma", "prisma.config.ts", "src/generated", "vitest.integration.config.ts", "scripts/dev-db", ...FORBIDDEN_FILES]
      .filter((f) => fs.existsSync(path.join(ROOT, f)));
    expect(left).toEqual([]);
  });
});
