/** A refusal: a stable `code` to switch on, and the HTTP status that fits it. */
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, options?: { status?: number; cause?: unknown });
}
