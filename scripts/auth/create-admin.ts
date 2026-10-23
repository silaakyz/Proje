/**
 * Creates the first administrator: an account (or an existing one without an organization) becomes the OWNER of a new
 * organization. This is how organizations are created when sign-up is invite-only (SIGNUP_MODE=invite); the owner then
 * invites the team from the Ekip page.
 *
 *   npm run admin:create -- <email> "<Kurum adı>" [KURUM_TÜRÜ]
 *   KURUM_TÜRÜ: MUNICIPALITY | PUBLIC_INSTITUTION | UNIVERSITY | COMPANY | EVENT_AGENCY | NONPROFIT | OTHER (default OTHER)
 *
 * Asks for the password (input hidden) when the account is new or has no password; an existing password is kept.
 * WRITES TO THE DATABASE IN DATABASE_URL. The password is never printed.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

function fail(message: string): never {
  console.error(`admin:create — ${message}`);
  process.exit(1);
}

const [rawEmail, orgName, rawType] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
const TYPES = ["MUNICIPALITY", "PUBLIC_INSTITUTION", "UNIVERSITY", "COMPANY", "EVENT_AGENCY", "NONPROFIT", "OTHER"] as const;
const type = (rawType?.trim().toUpperCase() || "OTHER") as (typeof TYPES)[number];
if (!email || !orgName?.trim()) fail('usage: npm run admin:create -- <email> "<Kurum adı>" [KURUM_TÜRÜ]');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("the e-mail address is not valid.");
if (orgName.trim().length < 2 || orgName.trim().length > 120) fail("the organization name must be 2–120 characters.");
if (!TYPES.includes(type)) fail(`unknown organization type ${rawType}; use one of ${TYPES.join(", ")}.`);
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (.env).");

/** Lines of a piped stdin (non-interactive use), read once. */
let piped: AsyncIterator<string> | null = null;

/** Reads a line without echoing it; when stdin is not a terminal, the next piped line. */
async function askHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    if (!piped) {
      const { createInterface } = await import("node:readline");
      piped = createInterface({ input: stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
    }
    process.stdout.write(`${prompt}\n`);
    const next = await piped.next();
    return next.done ? "" : next.value;
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (c === "\u0003") process.exit(130); // Ctrl+C
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}

const { eq, sql } = await import("drizzle-orm");
const { adminDb } = await import("@/db");
const { authUsers } = await import("@/db/auth-schema");
const { users } = await import("@/db/schema");
const { hashPassword } = await import("@/server/auth/password");
const { createOrganizationForUser } = await import("@/server/org/onboarding");

let [account] = await adminDb.select({ id: authUsers.id, passwordHash: authUsers.passwordHash }).from(authUsers)
  .where(sql`lower(${authUsers.email}) = ${email}`).limit(1);
if (account) {
  const [profile] = await adminDb.select({ organizationId: users.organizationId }).from(users).where(eq(users.id, account.id)).limit(1);
  if (profile) fail(`${email} already belongs to an organization; nothing changed.`);
}
if (!account?.passwordHash) {
  const password = await askHidden("Password for the administrator (8–72 characters): ");
  if (password.length < 8 || password.length > 72) fail("the password must be 8–72 characters.");
  const again = await askHidden("Repeat the password: ");
  if (again !== password) fail("the passwords do not match.");
  const passwordHash = await hashPassword(password);
  if (account) await adminDb.update(authUsers).set({ passwordHash }).where(eq(authUsers.id, account.id));
  else [account] = await adminDb.insert(authUsers).values({ email, passwordHash }).returning({ id: authUsers.id, passwordHash: authUsers.passwordHash });
}
const org = await createOrganizationForUser({ sub: account!.id, email } as never, { organizationName: orgName.trim(), organizerType: type });
console.log(`created organization "${org.organizationName}" (${org.organizerType}) with ${email} as owner. Sign in at /giris.`);
process.exit(0);
