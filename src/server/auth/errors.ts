/**
 * Authentication/authorization errors shared by every Route Handler (401 / 403).
 * Kept free of database imports so that the error mapping in src/server/http.ts does not pull the
 * database layer into a route's module graph.
 */
export class AuthError extends Error {
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
  }
}
