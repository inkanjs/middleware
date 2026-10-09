/** A random, URL-safe token: `bytes` (16 to 1024, default 32) random bytes as base64url. */
export function randomToken(bytes?: number): string;
/** SHA-256 of a token as base64url, for storing refresh, reset and invite tokens. */
export function hashToken(token: string): string;
/** Constant-time string equality for strings of any length (both are hashed first). */
export function safeEqual(a: unknown, b: unknown): boolean;
