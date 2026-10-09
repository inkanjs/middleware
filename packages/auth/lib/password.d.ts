/** scrypt cost: N = 2^ln, block size r, parallelism p. */
export interface ScryptParams {
  /** Default 17 (N = 131072), from 14 to 20. */
  ln?: number;
  /** Default 8. */
  r?: number;
  /** Default 1. */
  p?: number;
}

export const DEFAULTS: Readonly<Required<ScryptParams>>;
export const MAX_PASSWORD_BYTES: number;

/** `$scrypt$ln=17,r=8,p=1$<salt>$<hash>`; rejects with AuthError `password-invalid` for an empty or too long password. */
export function hashPassword(password: string, opts?: ScryptParams): Promise<string>;
/** Constant-time check; false for a wrong password and for a malformed hash. */
export function verifyPassword(password: string, hash: string): Promise<boolean>;
/** Whether the hash is malformed or made with other parameters than `opts`. */
export function needsRehash(hash: string, opts?: ScryptParams): boolean;
