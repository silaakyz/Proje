/**
 * Deletes an organization with all of its data — e.g. the former demo organization:
 *
 *   npm run org:delete -- "<Kurum adı>" [--hesaplar]
 *
 * Shows what will be removed and asks you to type the organization's name again. `--hesaplar` also deletes the
 * members' sign-in accounts (otherwise they stay, without an organization, and can be invited elsewhere).
 * WRITES TO THE DATABASE IN DATABASE_URL and cannot be undone: take a backup first (docs/canliya-alma.md §8).
 */
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

function fail(message: string): never {
  console.error(`org:delete — ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const deleteAccounts = args.includes("--hesaplar") || args.includes("--accounts");
const name = args.filter((a) => !a.startsWith("--")).join(" ").trim();
if (!name) fail('usage: npm run org:delete -- "<Kurum adı>" [--hesaplar]');
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (.env).");

async function ask(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  try {
    if (!process.stdin.isTTY) process.stdout.write(`${prompt}\n`);
    return (await rl.question(process.stdin.isTTY ? prompt : "")).trim();
  } finally {
    rl.close();
  }
}

const { findOrganizations, deleteOrganization } = await import("@/server/org/delete-organization");
const found = await findOrganizations(name);
if (!found.length) fail(`no organization named "${name}".`);
if (found.length > 1) fail(`${found.length} organizations are named "${name}"; rename one first so the right one is deleted.`);
const org = found[0]!;
console.log(`Organization "${org.name}" (${org.id})`);
console.log(`  events: ${org.events} (with all their tasks, attendees, registrations, surveys, responses, budget, impact runs)`);
console.log(`  members: ${org.members.map((m) => m.email ?? m.id).join(", ") || "none"}`);
console.log(deleteAccounts ? "  the members' sign-in accounts are deleted too." : "  the members' sign-in accounts are kept (without an organization).");
const typed = await ask(`Type the organization name to delete it permanently: `);
if (typed.toLocaleLowerCase("tr-TR") !== org.name.toLocaleLowerCase("tr-TR")) fail("the name did not match; nothing deleted.");
const r = await deleteOrganization(org.id, { deleteAccounts });
console.log(`deleted "${org.name}": ${r.events} events, ${r.members} member profiles${deleteAccounts ? `, ${r.accounts} sign-in accounts` : ""}.`);
process.exit(0);
