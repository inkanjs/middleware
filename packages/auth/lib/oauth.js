// OAuth 2.0 authorization code flow (RFC 6749) with PKCE (RFC 7636), and OpenID Connect
// (Core 1.0, Discovery 1.0) on top of it: build the authorize URL, exchange the code, and
// for OIDC validate the id_token against the provider's keys.
import { createHash, randomBytes } from "node:crypto";
import { AuthError } from "./errors.js";
import { fetchJson, isObject, secureUrl } from "./http.js";
import { jwksSource, verifyJwt, SUPPORTED_ALGORITHMS } from "./jwt.js";
import { randomToken, safeEqual } from "./tokens.js";

const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_TIMEOUT = 10_000;
const DISCOVERY_TTL = 60 * 60_000;
const ASYMMETRIC = SUPPORTED_ALGORITHMS.filter((a) => !a.startsWith("HS"));

// ---- PKCE and state -----------------------------------------------------------------------

/** The S256 code challenge of a verifier (RFC 7636 4.2): BASE64URL(SHA256(ASCII(verifier))). */
export function pkceChallenge(verifier) {
  if (typeof verifier !== "string" || !VERIFIER.test(verifier)) {
    throw new TypeError("pkceChallenge: a verifier is 43 to 128 characters of A-Z a-z 0-9 - . _ ~");
  }
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** A fresh PKCE pair: a 256-bit verifier (43 characters) and its S256 challenge. */
export function pkcePair() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier), method: "S256" };
}

/** A random value for `state` (and `nonce`): 256 bits, base64url. */
export function randomState() {
  return randomToken(32);
}

// ---- providers ----------------------------------------------------------------------------

function freezeProvider(p) {
  if (typeof p.id !== "string" || p.id.length === 0) throw new TypeError("provider: id is required");
  if (p.kind === "oauth2") {
    secureUrl(p.authorizationEndpoint, `${p.id} authorizationEndpoint`);
    secureUrl(p.tokenEndpoint, `${p.id} tokenEndpoint`);
  } else if (p.kind === "oidc") {
    secureUrl(p.issuer, `${p.id} issuer`);
  } else {
    throw new TypeError("provider: kind must be oauth2 or oidc");
  }
  if (p.apiUrl !== undefined) secureUrl(p.apiUrl, `${p.id} apiUrl`);
  return Object.freeze({ ...p, scope: Object.freeze([...p.scope]) });
}

/**
 * GitHub (OAuth 2.0, no OIDC): the user comes from api.github.com/user, the email from
 * /user/emails (the primary, verified one). The URLs can be overridden, for GitHub
 * Enterprise or tests.
 */
export function github(overrides = {}) {
  return freezeProvider({
    id: "github",
    kind: "oauth2",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    apiUrl: "https://api.github.com",
    scope: ["read:user", "user:email"],
    ...overrides,
  });
}

/** Google (OpenID Connect): endpoints and keys from its discovery document. */
export function google(overrides = {}) {
  return oidcProvider({ id: "google", issuer: "https://accounts.google.com", ...overrides });
}

/** Any OpenID Connect provider, by its issuer URL. */
export function oidcProvider({ id = "oidc", issuer, scope = ["openid", "email", "profile"], ...rest }) {
  if (!scope.includes("openid")) throw new TypeError("oidcProvider: scope must include openid");
  return freezeProvider({ ...rest, id, kind: "oidc", issuer, scope });
}

// ---- discovery ----------------------------------------------------------------------------

/** @type {Map<string, { at: number, value: Promise<any> }>} */
const discoveries = new Map();

/**
 * The OpenID Provider metadata of `issuerUrl`, cached for an hour (failures are not cached).
 * The document's issuer must equal `issuerUrl` exactly, and its endpoints must be https.
 */
export function discover(issuerUrl, { fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT } = {}) {
  const issuer = String(issuerUrl);
  secureUrl(issuer, "issuer");
  const cached = discoveries.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL) return cached.value;
  const value = load(issuer, fetch, timeoutMs);
  discoveries.set(issuer, { at: Date.now(), value });
  value.catch(() => {
    if (discoveries.get(issuer)?.value === value) discoveries.delete(issuer);
  });
  return value;
}

/** Forgets cached discovery documents. */
export function clearDiscoveryCache() {
  discoveries.clear();
}

async function load(issuer, fetch, timeoutMs) {
  const url = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
  const codes = { fetch, timeoutMs, unavailableCode: "oidc-discovery", badCode: "oidc-discovery" };
  const { ok, status, body } = await fetchJson(url, { headers: { accept: "application/json" } }, codes);
  const fail = (why) => new AuthError("oidc-discovery", `discovery of ${issuer}: ${why}`, { status: 502 });
  if (!ok) throw fail(`answered ${status}`);
  if (!isObject(body)) throw fail("not a JSON object");
  if (body.issuer !== issuer) throw fail("issuer in the document does not match");
  const endpoint = (name, required) => {
    const v = body[name];
    if (v === undefined && !required) return undefined;
    if (typeof v !== "string") throw fail(`${name} is missing`);
    try {
      return secureUrl(v, name).href;
    } catch {
      throw fail(`${name} is not an https URL`);
    }
  };
  if (Array.isArray(body.response_types_supported) && !body.response_types_supported.includes("code")) {
    throw fail("the code flow is not supported");
  }
  const advertised = Array.isArray(body.id_token_signing_alg_values_supported) ? body.id_token_signing_alg_values_supported : ["RS256"];
  // never HS*: an id_token MACed with the client secret is not accepted, nor "none"
  const idTokenAlgorithms = advertised.filter((a) => ASYMMETRIC.includes(a));
  if (idTokenAlgorithms.length === 0) throw fail("no supported id_token signing algorithm");
  const jwksUri = endpoint("jwks_uri", true);
  return Object.freeze({
    issuer,
    authorizationEndpoint: endpoint("authorization_endpoint", true),
    tokenEndpoint: endpoint("token_endpoint", true),
    userinfoEndpoint: endpoint("userinfo_endpoint", false),
    jwksUri,
    idTokenAlgorithms: Object.freeze(idTokenAlgorithms),
    jwks: jwksSource(/** @type {string} */ (jwksUri), { fetch, timeoutMs }),
  });
}

async function endpoints(provider, opts) {
  if (!isObject(provider) || (provider.kind !== "oauth2" && provider.kind !== "oidc")) {
    throw new TypeError("provider must come from github(), google() or oidcProvider()");
  }
  if (provider.kind === "oauth2") return provider;
  return discover(provider.issuer, opts);
}

// ---- authorize ----------------------------------------------------------------------------

const RESERVED = new Set(["response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "nonce"]);

function nonEmpty(value, name, max = 2048) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

/**
 * The URL to send the user to. `state` and `codeChallenge` (S256) are required, and for an
 * OIDC provider `nonce` too; keep them (and the PKCE verifier) server side until the callback.
 */
export async function buildAuthorizeUrl(provider, options) {
  const { clientId, redirectUri, scope, state, codeChallenge, nonce, params = {}, fetch, timeoutMs } = options ?? {};
  const meta = await endpoints(provider, { fetch, timeoutMs });
  nonEmpty(clientId, "clientId");
  secureUrl(nonEmpty(redirectUri, "redirectUri"), "redirectUri");
  if (typeof state !== "string" || state.length < 16) throw new TypeError("buildAuthorizeUrl: state is required, at least 16 characters (use randomState())");
  if (typeof codeChallenge !== "string" || !CHALLENGE.test(codeChallenge)) throw new TypeError("buildAuthorizeUrl: codeChallenge is required, an S256 challenge (use pkcePair())");
  if (provider.kind === "oidc" && (typeof nonce !== "string" || nonce.length < 16)) {
    throw new TypeError("buildAuthorizeUrl: an OIDC provider needs a nonce, at least 16 characters (use randomState())");
  }
  const scopes = scope === undefined ? provider.scope : Array.isArray(scope) ? scope : String(scope).split(" ");
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scopes.filter(Boolean).join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (nonce !== undefined) url.searchParams.set("nonce", nonEmpty(nonce, "nonce"));
  for (const [name, value] of Object.entries(params)) {
    if (RESERVED.has(name)) throw new TypeError(`buildAuthorizeUrl: ${name} cannot be set through params`);
    url.searchParams.set(name, String(value));
  }
  return url.href;
}

// ---- exchange -----------------------------------------------------------------------------

/**
 * Exchanges the authorization code for tokens and the user. For GitHub the user comes from
 * its API; for OIDC from the id_token, which must be signed by the provider's keys, issued
 * by it, for `clientId`, unexpired, and carry the `nonce` given to buildAuthorizeUrl.
 * Resolves to `{ tokens, user, claims? }`; rejects with an AuthError (`oauth-error`,
 * `oauth-response`, `oauth-unavailable`, `oidc-discovery`, `oidc-nonce` or a `token-*` code).
 */
export async function exchangeCode(provider, options) {
  const { code, clientId, clientSecret, redirectUri, codeVerifier, nonce, fetch = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT, clockTolerance = 0, now } = options ?? {};
  const meta = await endpoints(provider, { fetch, timeoutMs });
  nonEmpty(code, "code");
  nonEmpty(clientId, "clientId");
  nonEmpty(redirectUri, "redirectUri");
  if (typeof codeVerifier !== "string" || !VERIFIER.test(codeVerifier)) throw new TypeError("exchangeCode: codeVerifier is required");
  if (provider.kind === "oidc") nonEmpty(nonce, "nonce");

  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier });
  if (clientSecret !== undefined) form.set("client_secret", nonEmpty(clientSecret, "clientSecret"));
  const http = { fetch, timeoutMs, unavailableCode: "oauth-unavailable", badCode: "oauth-response" };
  const { ok, status, body } = await fetchJson(
    meta.tokenEndpoint,
    { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form.toString() },
    http,
  );
  if (!isObject(body)) throw new AuthError("oauth-response", "token answer is not a JSON object", { status: 502 });
  // GitHub answers refusals with 200 and an error member, so look for it before `ok`
  if (typeof body.error === "string") {
    throw new AuthError("oauth-error", `provider refused the code: ${body.error.slice(0, 64).replace(/[^\w.-]/g, "?")}`, { status: 401 });
  }
  if (!ok) throw new AuthError(status >= 500 ? "oauth-unavailable" : "oauth-response", `token endpoint answered ${status}`, { status: 502 });
  if (typeof body.access_token !== "string" || body.access_token.length === 0) throw new AuthError("oauth-response", "no access_token", { status: 502 });
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") throw new AuthError("oauth-response", "token_type is not Bearer", { status: 502 });
  const tokens = {
    accessToken: body.access_token,
    tokenType: "Bearer",
    scope: typeof body.scope === "string" ? body.scope : undefined,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : undefined,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
  };

  if (provider.kind === "oauth2") {
    if (provider.id !== "github") return { tokens, user: undefined };
    return { tokens, user: await githubUser(provider.apiUrl, tokens.accessToken, http) };
  }

  if (!tokens.idToken) throw new AuthError("oauth-response", "no id_token from an OIDC provider", { status: 502 });
  const { payload } = await verifyJwt(tokens.idToken, {
    jwks: meta.jwks,
    algorithms: meta.idTokenAlgorithms,
    issuer: meta.issuer,
    audience: clientId,
    clockTolerance,
    now,
  });
  if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp === undefined) {
    throw new AuthError("token-audience", "an id_token for several audiences needs azp");
  }
  if (payload.azp !== undefined && payload.azp !== clientId) throw new AuthError("token-audience", "id_token azp is another client");
  if (!safeEqual(payload.nonce, nonce)) throw new AuthError("oidc-nonce", "id_token nonce does not match");
  if (typeof payload.sub !== "string" || payload.sub.length === 0) throw new AuthError("token-malformed", "id_token has no sub");
  return {
    tokens,
    claims: payload,
    user: {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === "string" ? payload.name : null,
      avatarUrl: typeof payload.picture === "string" ? payload.picture : null,
    },
  };
}

async function githubUser(apiUrl, accessToken, http) {
  const base = String(apiUrl).replace(/\/+$/, "");
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "inkanjs-auth",
    "x-github-api-version": "2022-11-28",
  };
  const profile = await fetchJson(`${base}/user`, { headers }, http);
  if (!profile.ok) throw new AuthError(profile.status >= 500 ? "oauth-unavailable" : "oauth-response", `GitHub /user answered ${profile.status}`, { status: 502 });
  const u = profile.body;
  if (!isObject(u) || !Number.isSafeInteger(u.id) || typeof u.login !== "string") throw new AuthError("oauth-response", "GitHub /user is not a user", { status: 502 });
  // only a primary, verified address counts; the profile's public email is not verified
  let email = null;
  const emails = await fetchJson(`${base}/user/emails`, { headers }, http).catch(() => null);
  if (emails?.ok && Array.isArray(emails.body)) {
    const primary = emails.body.find((e) => isObject(e) && e.primary === true && e.verified === true && typeof e.email === "string");
    if (primary) email = primary.email;
  }
  return {
    id: String(u.id),
    login: u.login,
    name: typeof u.name === "string" ? u.name : null,
    email,
    emailVerified: email !== null,
    avatarUrl: typeof u.avatar_url === "string" ? u.avatar_url : null,
  };
}

