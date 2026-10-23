/**
 * Sets a new password for an existing account and ends all of its sessions (there is no reset e-mail in the MVP).
 *
 *   npm run auth:set-password -- someone@example.com      (asks for the new password)
 *
 * WRITES TO THE DATABASE IN DATABASE_URL. The password is never printed.
 */
import { createInterface } from "node:readline/promises";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

function fail(message: string): never {
  console.error(`auth:set-password — ${message}`);
  process.exit(1);
}
const email = process.argv[2]?.trim().toLowerCase();
if (!email) fail("usage: npm run auth:set-password -- <email>");
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (.env).");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const password = await rl.question("New password (8–72 characters): ");
rl.close();
if (password.length < 8 || password.length > 72) fail("the password must be 8–72 characters.");

const { eq, sql } = await import("drizzle-orm");
const { adminDb } = await import("@/db");
const { authSessions, authUsers } = await import("@/db/auth-schema");
const { hashPassword } = await import("@/server/auth/password");

const [account] = await adminDb.update(authUsers).set({ passwordHash: await hashPassword(password) })
  .where(sql`lower(${authUsers.email}) = ${email}`).returning({ id: authUsers.id });
if (!account) fail(`no account with the address ${email}.`);
await adminDb.delete(authSessions).where(eq(authSessions.userId, account.id));
console.log(`password updated for ${email}; its sessions were ended.`);
process.exit(0);
