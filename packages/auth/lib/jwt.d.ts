import type { KeyObject } from "node:crypto";

export type JwtAlgorithm =
  | "HS256" | "HS384" | "HS512"
  | "RS256" | "RS384" | "RS512"
  | "PS256" | "PS384" | "PS512"
  | "ES256" | "ES384" | "ES512"
  | "EdDSA";

export const SUPPORTED_ALGORITHMS: readonly JwtAlgorithm[];
export const MAX_TOKEN_LENGTH: number;

/** A JWK as JSON. */
export type Jwk = { kty: string; [member: string]: unknown };
/** An HMAC secret: a string (taken as UTF-8), bytes, or a secret KeyObject. */
export type Secret = string | Uint8Array | KeyObject;
/** An asymmetric key: a KeyObject, a PEM string, or a JWK. */
export type AsymmetricKey = KeyObject | string | Jwk;
/** Seconds, or a string like "30s", "15m", "12h", "7d". */
export type Duration = number | `${number}${"s" | "m" | "h" | "d"}`;

export type JwtHeader = { alg: JwtAlgorithm; typ?: string; kid?: string; [member: string]: unknown };
export type JwtPayload = {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
};

export interface KeySource {
  getKey(header: JwtHeader): Promise<KeyObject>;
}

export interface VerifyOptions {
  /** The algorithms you accept. Required: there is no default, and "none" is never accepted. */
  algorithms: readonly JwtAlgorithm[];
  /** The HMAC secret, for HS* only. */
  secret?: Secret;
  /** The public key (a private key gives its public half), for RS*, PS*, ES* and EdDSA only. */
  key?: AsymmetricKey;
  /** Keys by kid, from jwksSource(). */
  jwks?: KeySource;
  issuer?: string | readonly string[];
  audience?: string | readonly string[];
  /** Leeway for exp, nbf, iat and maxAge, in seconds. Default 0. */
  clockTolerance?: Duration;
  /** Refuse tokens issued longer ago than this. Needs iat. */
  maxAge?: Duration;
  /** The time to check against. Default: now. */
  now?: Date | number;
  /** Refuse tokens without exp. Default true. */
  requireExp?: boolean;
}

export function verifyJwt<P extends JwtPayload = JwtPayload>(
  token: string,
  options: VerifyOptions,
): Promise<{ header: JwtHeader; payload: P }>;

export interface SignOptions {
  algorithm: JwtAlgorithm;
  /** For HS*. */
  secret?: Secret;
  /** For RS*, PS*, ES* and EdDSA. */
  privateKey?: AsymmetricKey;
  /** Lifetime from iat. Required unless the payload has exp. */
  expiresIn?: Duration;
  notBefore?: Duration;
  issuer?: string;
  audience?: string | readonly string[];
  subject?: string;
  jwtId?: string;
  kid?: string;
  now?: Date | number;
}

export function signJwt(payload: JwtPayload, options: SignOptions): string;

export interface JwksOptions {
  /** How long fetched keys are used before fetching again. Default 10 minutes. */
  cacheMs?: number;
  /** Minimum time between fetches caused by an unknown kid, and after a failed fetch. Default 30 seconds. */
  cooldownMs?: number;
  /** How long the last keys are still used past cacheMs while the provider cannot be reached. Default 1 hour. */
  staleMs?: number;
  /** Default 5 seconds. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  /** The clock for caching, in milliseconds. Default Date.now. */
  clock?: () => number;
}

export function jwksSource(url: string | URL, options?: JwksOptions): KeySource & { readonly url: string };

/** @internal */
export function signRaw(alg: JwtAlgorithm, key: KeyObject, input: string | Uint8Array): Buffer;
/** @internal */
export function verifyRaw(alg: JwtAlgorithm, key: KeyObject, input: string | Uint8Array, signature: Uint8Array): boolean;
/** @internal */
export function toPublicKey(key: AsymmetricKey, where?: string): KeyObject;
