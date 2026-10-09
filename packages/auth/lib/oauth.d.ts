import type { JwtAlgorithm, JwtPayload, KeySource } from "./jwt.js";

export interface OAuth2Provider {
  readonly id: string;
  readonly kind: "oauth2";
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly apiUrl?: string;
  readonly scope: readonly string[];
}
export interface OidcProvider {
  readonly id: string;
  readonly kind: "oidc";
  readonly issuer: string;
  readonly scope: readonly string[];
}
export type Provider = OAuth2Provider | OidcProvider;

export interface ProviderMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly userinfoEndpoint: string | undefined;
  readonly jwksUri: string;
  readonly idTokenAlgorithms: readonly JwtAlgorithm[];
  readonly jwks: KeySource;
}

export interface HttpOptions {
  fetch?: typeof globalThis.fetch;
  /** Default 10 seconds. */
  timeoutMs?: number;
}

export function pkceChallenge(verifier: string): string;
export function pkcePair(): { verifier: string; challenge: string; method: "S256" };
export function randomState(): string;

export function github(overrides?: Partial<Omit<OAuth2Provider, "kind">>): OAuth2Provider;
export function google(overrides?: Partial<Omit<OidcProvider, "kind">>): OidcProvider;
export function oidcProvider(options: { issuer: string; id?: string; scope?: readonly string[] }): OidcProvider;

export function discover(issuerUrl: string | URL, options?: HttpOptions): Promise<ProviderMetadata>;
export function clearDiscoveryCache(): void;

export function buildAuthorizeUrl(
  provider: Provider,
  options: HttpOptions & {
    clientId: string;
    redirectUri: string;
    /** Default: the provider's scope. */
    scope?: string | readonly string[];
    state: string;
    codeChallenge: string;
    /** Required for OIDC providers. */
    nonce?: string;
    params?: Record<string, string | number | boolean>;
  },
): Promise<string>;

export interface OAuthTokens {
  accessToken: string;
  tokenType: "Bearer";
  scope: string | undefined;
  expiresIn: number | undefined;
  refreshToken: string | undefined;
  idToken: string | undefined;
}

export interface OAuthUser {
  id: string;
  login?: string;
  name: string | null;
  email: string | null;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export function exchangeCode(
  provider: Provider,
  options: HttpOptions & {
    code: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    codeVerifier: string;
    /** Required for OIDC providers: the nonce given to buildAuthorizeUrl. */
    nonce?: string;
    /** Leeway for the id_token's times, in seconds. Default 0. */
    clockTolerance?: number;
    now?: Date | number;
  },
): Promise<{ tokens: OAuthTokens; user: OAuthUser | undefined; claims?: JwtPayload }>;
