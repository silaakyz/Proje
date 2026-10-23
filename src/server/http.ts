import "server-only";
import { z } from "zod";
import { AuthError } from "@/server/auth/errors";
import { PROPOSAL_ERROR_HTTP_STATUS, ProposalError } from "@/server/planning/proposal-error";

/** A request the API refuses with a known status (404 not found, 409 conflict, …). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Maps known domain errors to HTTP responses; rethrows anything else (→ 500 + logs). */
export function toErrorResponse(e: unknown): Response {
  if (e instanceof AuthError) return Response.json({ error: e.message }, { status: e.status });
  // getUserDb() without a valid session (by class name: @/db is not imported here, and tests replace it).
  if (e instanceof Error && (e.name === "UnauthenticatedError" || e.constructor.name === "UnauthenticatedError")) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (e instanceof ApiError) return Response.json({ error: e.message, ...(e.code ? { code: e.code } : {}), ...e.details }, { status: e.status });
  if (e instanceof ProposalError) {
    const status = PROPOSAL_ERROR_HTTP_STATUS[e.code];
    return Response.json({ error: e.message, code: e.code }, { status });
  }
  if (e instanceof z.ZodError) return Response.json({ error: z.treeifyError(e) }, { status: 400 });
  throw e;
}
