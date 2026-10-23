/**
 * Removes connection secrets from text before scripts/db/migrate.mjs prints it.
 * Redacted: the connection URL itself, its password (as written and percent-decoded), PGPASSWORD, and
 * the user:password part of any other URL in the text.
 */
export function makeRedactor(url, env = process.env) {
  const secrets = [url];
  try {
    const pw = new URL(url).password;
    if (pw) {
      secrets.push(pw);
      try { secrets.push(decodeURIComponent(pw)); } catch { /* malformed escape: the raw form is enough */ }
    }
  } catch { /* not parseable as a URL: the whole string is redacted as given */ }
  if (env.PGPASSWORD) secrets.push(env.PGPASSWORD);
  const list = secrets.filter((s) => typeof s === "string" && s !== "").sort((a, b) => b.length - a.length);
  return (value) => {
    let text = String(value);
    for (const s of list) text = text.split(s).join("[redacted]");
    return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[redacted]@");
  };
}
