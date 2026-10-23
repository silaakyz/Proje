/**
 * Proposal domain errors and the public proposal status, shared by the Drizzle apply service.
 */
export type ProposalErrorCode = "NOT_FOUND" | "NOT_PENDING" | "NO_EVENT" | "INVALID" | "CONFLICT" | "FORBIDDEN" | "EXPIRED";

export class ProposalError extends Error {
  constructor(
    public readonly code: ProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProposalError";
  }
}

/** HTTP status per code. */
export const PROPOSAL_ERROR_HTTP_STATUS: Record<ProposalErrorCode, number> = {
  NOT_FOUND: 404, NOT_PENDING: 409, CONFLICT: 409, NO_EVENT: 409, INVALID: 422, FORBIDDEN: 403, EXPIRED: 410,
};

/**
 * The API keeps reporting an applied proposal as "APPLIED" (original API contract). In the Drizzle
 * database the same state is stored as APPROVED: approval and application happen in one transaction.
 */
export const PROPOSAL_API_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPLIED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
} as const;
export type ProposalDbStatus = keyof typeof PROPOSAL_API_STATUS;
export type ProposalApiStatus = (typeof PROPOSAL_API_STATUS)[ProposalDbStatus];
export const toApiProposalStatus = (s: ProposalDbStatus): ProposalApiStatus => PROPOSAL_API_STATUS[s];
