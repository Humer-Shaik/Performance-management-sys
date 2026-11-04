export type DomainErrorCode = "forbidden" | "not_found" | "invalid" | "conflict";

/** A rule from the plan was broken. The message is safe to show the user. */
export class DomainError extends Error {
  constructor(public code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const forbid = (msg: string): never => { throw new DomainError("forbidden", msg); };
export const invalid = (msg: string): never => { throw new DomainError("invalid", msg); };
export const notFound = (msg: string): never => { throw new DomainError("not_found", msg); };

export function requireReason(reason: string | undefined, what: string): string {
  if (!reason || !reason.trim()) invalid(`${what} needs a reason`);
  return reason!.trim();
}
