/**
 * Every refusal of @inkanjs/auth: a stable `code` to switch on and the HTTP `status` that
 * fits it. The message is for logs, never for the client: it says what failed, not why a
 * forged token almost passed.
 */
export class AuthError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AuthError";
    this.code = code;
    this.status = options.status ?? 401;
  }
}
