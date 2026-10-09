import { test, describe, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { AuthError } from "../lib/errors.js";
import { signJwt } from "../lib/jwt.js";
import {
  buildAuthorizeUrl,
  clearDiscoveryCache,
  discover,
  exchangeCode,
  github,
  google,
  oidcProvider,
  pkceChallenge,
  pkcePair,
  randomState,
} from "../lib/oauth.js";
import { json, serve } from "./server.ts";

const code = (expected: string) => (err: unknown) => {
  assert.ok(err instanceof AuthError, `expected AuthError ${expected}, got ${String(err)}`);
  assert.equal(err.code, expected);
  return true;
};

test("RFC 7636 appendix B: the S256 challenge", () => {
  assert.equal(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("pkcePair and randomState", () => {
  const pair = pkcePair();
  assert.match(pair.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(pair.challenge, pkceChallenge(pair.verifier));
  assert.equal(pair.method, "S256");
  assert.notEqual(pkcePair().verifier, pair.verifier);
  assert.match(randomState(), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(randomState(), randomState());
  assert.throws(() => pkceChallenge("short"), TypeError);
  assert.throws(() => pkceChallenge("a".repeat(42) + "!"), TypeError);
});

test("providers must use https", () => {
  assert.throws(() => github({ tokenEndpoint: "http://evil.example/token" }), /https/);
  assert.throws(() => oidcProvider({ issuer: "http://evil.example" }), /https/);
  assert.equal(google().issuer, "https://accounts.google.com");
  assert.equal(github().tokenEndpoint, "https://github.com/login/oauth/access_token");
  assert.throws(() => oidcProvider({ issuer: "https://idp.example", scope: ["email"] }), /openid/);
});

// ---- a fake provider: GitHub's endpoints and an OpenID provider on one loopback server ----

const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CLIENT = { clientId: "client-1", clientSecret: "s3cret-client", redirectUri: "http://localhost:3000/callback" };

type IdTokenTweak = { claims?: Record<string, unknown>; options?: Record<string, unknown> };
const state = {
  challenge: "",
  nonce: "",
  idToken: {} as IdTokenTweak,
  tokenAnswer: null as null | ((res: import("node:http").ServerResponse) => void),
  discoveryHits: 0,
  received: {} as Record<string, string>,
};

const server = await serve(async (req, body, res) => {
  const url = new URL(req.url ?? "/", base());
  switch (url.pathname) {
    case "/.well-known/openid-configuration":
      state.discoveryHits++;
      return json(res, 200, {
        issuer: base(),
        authorization_endpoint: `${base()}/authorize`,
        token_endpoint: `${base()}/token`,
        jwks_uri: `${base()}/jwks`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256", "HS256", "none"],
      });
    case "/jwks":
      return json(res, 200, { keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid: "p1", use: "sig", alg: "RS256" }] });
    case "/token":
    case "/login/oauth/access_token": {
      const form = Object.fromEntries(new URLSearchParams(body));
      state.received = form;
      if (state.tokenAnswer) return state.tokenAnswer(res);
      const pkceOk = createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === state.challenge;
      if (form.code !== "good-code" || !pkceOk || form.client_secret !== CLIENT.clientSecret || form.redirect_uri !== CLIENT.redirectUri) {
        // GitHub style: a refusal with status 200
        return json(res, url.pathname === "/token" ? 400 : 200, { error: "bad_verification_code", error_description: "nope" });
      }
      if (url.pathname === "/login/oauth/access_token") return json(res, 200, { access_token: "gho_test", token_type: "bearer", scope: "read:user,user:email" });
      const idToken = signJwt(
        { sub: "u-1", nonce: state.nonce, email: "ada@example.com", email_verified: true, name: "Ada", ...state.idToken.claims },
        { algorithm: "RS256", privateKey: signing.privateKey, kid: "p1", issuer: base(), audience: CLIENT.clientId, expiresIn: 300, ...state.idToken.options },
      );
      return json(res, 200, { access_token: "at-1", token_type: "Bearer", expires_in: 3600, refresh_token: "rt-1", id_token: idToken });
    }
    case "/user":
      if (req.headers.authorization !== "Bearer gho_test") return json(res, 401, { message: "Bad credentials" });
      return json(res, 200, { id: 42, login: "octocat", name: "Mona", email: "public@example.com", avatar_url: "https://avatars.example/42" });
    case "/user/emails":
      return json(res, 200, [
        { email: "public@example.com", primary: false, verified: true },
        { email: "unverified@example.com", primary: true, verified: false },
        { email: "mona@example.com", primary: true, verified: true },
      ]);
    default:
      return json(res, 404, {});
  }
});
function base() {
  return server.url;
}
after(() => server.close());

const gh = () => github({ authorizationEndpoint: `${base()}/login/oauth/authorize`, tokenEndpoint: `${base()}/login/oauth/access_token`, apiUrl: base() });
const idp = () => oidcProvider({ id: "fake", issuer: base() });

beforeEach(() => {
  const pair = pkcePair();
  state.challenge = pair.challenge;
  state.nonce = randomState();
  state.idToken = {};
  state.tokenAnswer = null;
  currentVerifier = pair.verifier;
});
let currentVerifier = "";
const verifier = () => currentVerifier;

describe("authorize URL", () => {
  test("GitHub: code flow with state and S256 challenge", async () => {
    const st = randomState();
    const href = await buildAuthorizeUrl(gh(), { ...CLIENT, state: st, codeChallenge: state.challenge });
    const url = new URL(href);
    assert.equal(url.origin + url.pathname, `${base()}/login/oauth/authorize`);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "client-1");
    assert.equal(url.searchParams.get("redirect_uri"), CLIENT.redirectUri);
    assert.equal(url.searchParams.get("scope"), "read:user user:email");
    assert.equal(url.searchParams.get("state"), st);
    assert.equal(url.searchParams.get("code_challenge"), state.challenge);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.has("client_secret"), false);
  });

  test("state, challenge and (for OIDC) nonce are required; params cannot override them", async () => {
    const ok = { ...CLIENT, state: randomState(), codeChallenge: state.challenge };
    await assert.rejects(buildAuthorizeUrl(gh(), { ...ok, state: "" }), /state/);
    await assert.rejects(buildAuthorizeUrl(gh(), { ...ok, codeChallenge: "plain" }), /codeChallenge/);
    await assert.rejects(buildAuthorizeUrl(idp(), ok), /nonce/);
    await assert.rejects(buildAuthorizeUrl(gh(), { ...ok, params: { state: "x" } }), /state/);
    await assert.rejects(buildAuthorizeUrl(gh(), { ...ok, redirectUri: "http://evil.example/cb" }), /https/);
    const href = await buildAuthorizeUrl(gh(), { ...ok, params: { allow_signup: false }, scope: ["read:user"] });
    assert.equal(new URL(href).searchParams.get("allow_signup"), "false");
    assert.equal(new URL(href).searchParams.get("scope"), "read:user");
  });

  test("OIDC: the authorization endpoint comes from discovery, with nonce", async () => {
    const href = await buildAuthorizeUrl(idp(), { ...CLIENT, state: randomState(), codeChallenge: state.challenge, nonce: state.nonce });
    const url = new URL(href);
    assert.equal(url.pathname, "/authorize");
    assert.equal(url.searchParams.get("nonce"), state.nonce);
    assert.equal(url.searchParams.get("scope"), "openid email profile");
  });
});

describe("GitHub exchange", () => {
  test("code + verifier give the token and the user with the primary verified email", async () => {
    const { tokens, user } = await exchangeCode(gh(), { ...CLIENT, code: "good-code", codeVerifier: verifier() });
    assert.equal(tokens.accessToken, "gho_test");
    assert.equal(tokens.tokenType, "Bearer");
    assert.equal(state.received.code_verifier, verifier());
    assert.equal(state.received.grant_type, "authorization_code");
    assert.deepEqual(user, { id: "42", login: "octocat", name: "Mona", email: "mona@example.com", emailVerified: true, avatarUrl: "https://avatars.example/42" });
  });

  test("a refusal sent with status 200 is oauth-error", async () => {
    await assert.rejects(exchangeCode(gh(), { ...CLIENT, code: "bad-code", codeVerifier: verifier() }), code("oauth-error"));
    // a wrong verifier is refused by the provider the same way
    await assert.rejects(exchangeCode(gh(), { ...CLIENT, code: "good-code", codeVerifier: pkcePair().verifier }), code("oauth-error"));
  });

  test("the verifier is required", async () => {
    await assert.rejects(exchangeCode(gh(), { ...CLIENT, code: "good-code", codeVerifier: "" }), TypeError);
  });
});

describe("token endpoint answers are validated strictly", () => {
  const cases: [string, (res: import("node:http").ServerResponse) => void, string][] = [
    ["a 500", (res) => json(res, 500, { message: "down" }), "oauth-unavailable"],
    ["HTML", (res) => res.end("<html>"), "oauth-response"],
    ["an array", (res) => json(res, 200, []), "oauth-response"],
    ["no access_token", (res) => json(res, 200, { token_type: "bearer" }), "oauth-response"],
    ["an empty access_token", (res) => json(res, 200, { access_token: "", token_type: "bearer" }), "oauth-response"],
    ["another token_type", (res) => json(res, 200, { access_token: "x", token_type: "mac" }), "oauth-response"],
    ["a redirect (never followed)", (res) => { res.statusCode = 302; res.setHeader("location", "https://evil.example/"); res.end(); }, "oauth-unavailable"],
    ["a huge body", (res) => json(res, 200, { access_token: "x".repeat(2 * 1024 * 1024), token_type: "bearer" }), "oauth-response"],
  ];
  for (const [what, answer, expected] of cases) {
    test(what, async () => {
      state.tokenAnswer = answer;
      await assert.rejects(exchangeCode(gh(), { ...CLIENT, code: "good-code", codeVerifier: verifier() }), code(expected));
    });
  }

  test("a slow provider times out", async () => {
    state.tokenAnswer = (res) => void setTimeout(() => json(res, 200, {}), 1000);
    await assert.rejects(exchangeCode(gh(), { ...CLIENT, code: "good-code", codeVerifier: verifier(), timeoutMs: 100 }), code("oauth-unavailable"));
  });
});

describe("OIDC exchange", () => {
  const run = () => exchangeCode(idp(), { ...CLIENT, code: "good-code", codeVerifier: verifier(), nonce: state.nonce });

  test("the id_token is verified and gives the user", async () => {
    const { tokens, user, claims } = await run();
    assert.equal(tokens.accessToken, "at-1");
    assert.equal(tokens.refreshToken, "rt-1");
    assert.equal(tokens.expiresIn, 3600);
    assert.deepEqual(user, { id: "u-1", email: "ada@example.com", emailVerified: true, name: "Ada", avatarUrl: null });
    assert.equal(claims?.iss, base());
  });

  test("a wrong nonce is oidc-nonce", async () => {
    state.idToken = { claims: { nonce: "someone-elses-nonce" } };
    await assert.rejects(run(), code("oidc-nonce"));
    state.idToken = { claims: { nonce: undefined } };
    await assert.rejects(run(), code("oidc-nonce"));
  });

  test("another audience, issuer or azp is refused", async () => {
    state.idToken = { options: { audience: "client-2" } };
    await assert.rejects(run(), code("token-audience"));
    state.idToken = { options: { issuer: "https://evil.example" } };
    await assert.rejects(run(), code("token-issuer"));
    state.idToken = { claims: { azp: "client-2" } };
    await assert.rejects(run(), code("token-audience"));
    state.idToken = { options: { audience: ["client-1", "client-2"] } };
    await assert.rejects(run(), code("token-audience")); // several audiences need azp
  });

  test("an expired id_token is refused", async () => {
    state.idToken = { options: { now: Date.now() - 3600_000 } };
    await assert.rejects(run(), code("token-expired"));
  });

  test("an id_token MACed with the client secret (HS256) is refused although discovery lists it", async () => {
    const forged = signJwt({ sub: "admin", nonce: state.nonce }, { algorithm: "HS256", secret: "s3cret-client".repeat(4), issuer: base(), audience: CLIENT.clientId, expiresIn: 300 });
    state.tokenAnswer = (res) => json(res, 200, { access_token: "x", token_type: "Bearer", id_token: forged });
    await assert.rejects(run(), code("token-alg"));
  });

  test("an id_token signed by another key is refused", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    state.idToken = { options: { privateKey: other.privateKey } };
    await assert.rejects(run(), code("token-signature"));
  });

  test("an OIDC answer without id_token is refused", async () => {
    state.tokenAnswer = (res) => json(res, 200, { access_token: "x", token_type: "Bearer" });
    await assert.rejects(run(), code("oauth-response"));
  });

  test("the nonce is required", async () => {
    await assert.rejects(exchangeCode(idp(), { ...CLIENT, code: "good-code", codeVerifier: verifier() }), TypeError);
  });
});

describe("discovery", () => {
  test("is cached per issuer", async () => {
    clearDiscoveryCache();
    const before = state.discoveryHits;
    const a = await discover(base());
    const b = await discover(base());
    assert.equal(a, b);
    assert.equal(state.discoveryHits - before, 1);
    assert.deepEqual(a.idTokenAlgorithms, ["RS256"]); // HS256 and none are dropped
  });

  test("the document's issuer must match, and its endpoints must be https", async () => {
    let doc: Record<string, unknown> = {};
    const other = await serve((_req, _body, res) => json(res, 200, doc));
    try {
      const valid = { issuer: other.url, authorization_endpoint: `${other.url}/a`, token_endpoint: `${other.url}/t`, jwks_uri: `${other.url}/j` };
      for (const bad of [
        { ...valid, issuer: "https://accounts.example" },
        { ...valid, jwks_uri: "http://evil.example/jwks" },
        { ...valid, token_endpoint: undefined },
        { ...valid, id_token_signing_alg_values_supported: ["HS256"] },
        { ...valid, response_types_supported: ["token"] },
      ]) {
        doc = bad;
        clearDiscoveryCache();
        await assert.rejects(discover(other.url), code("oidc-discovery"), JSON.stringify(bad));
      }
      doc = valid;
      clearDiscoveryCache();
      assert.equal((await discover(other.url)).tokenEndpoint, `${other.url}/t`);
    } finally {
      await other.close();
    }
  });

  test("a failed discovery is not cached", async () => {
    let fail = true;
    const other = await serve((_req, _body, res) =>
      fail ? json(res, 503, {}) : json(res, 200, { issuer: other.url, authorization_endpoint: `${other.url}/a`, token_endpoint: `${other.url}/t`, jwks_uri: `${other.url}/j` }),
    );
    try {
      await assert.rejects(discover(other.url), code("oidc-discovery"));
      fail = false;
      assert.ok(await discover(other.url));
    } finally {
      await other.close();
    }
  });
});

