export type OtpAlgorithm = "SHA1" | "SHA256" | "SHA512";
/** Base32 text (as authenticator apps show it) or the raw bytes; at least 16 bytes. */
export type OtpSecret = string | Uint8Array;

export interface OtpOptions {
  /** 6 (default), 7 or 8. */
  digits?: number;
  /** Default "SHA1", which is what authenticator apps expect. */
  algorithm?: OtpAlgorithm;
}

export interface TotpOptions extends OtpOptions {
  /** The time; default now. */
  now?: Date | number;
  /** Seconds per step; default 30. */
  step?: number;
}

export interface VerifyTotpOptions extends TotpOptions {
  /** Steps accepted before and after the current one; default 1, at most 10. */
  window?: number;
  /** The step returned by the last successful check; it and older steps never match again. */
  lastUsedStep?: number | null;
}

export function base32Encode(bytes: Uint8Array): string;
export function base32Decode(text: string): Buffer;
export function hotp(secret: OtpSecret, counter: number, opts?: OtpOptions): string;
export function totp(secret: OtpSecret, opts?: TotpOptions): string;
/** The matched time step, or null. Store it and pass it back as lastUsedStep. */
export function verifyTotp(code: string, secret: OtpSecret, opts?: VerifyTotpOptions): number | null;
export function generateTotpSecret(): string;
export function otpauthUrl(options: {
  secret: OtpSecret;
  account: string;
  issuer?: string;
  algorithm?: OtpAlgorithm;
  digits?: number;
  period?: number;
}): string;
