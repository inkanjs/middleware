import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inkan } from "@vxnsin/inkan";
import { auth, github, type OAuthUser } from "../index.js";
import { SECRET, clock, cookieOf, makeUsers, setCookieOf, type User } from "./app.ts";
import { json, serve } from "./server.ts";

// a fake GitHub on the loopback: it checks the PKCE verifier against the challenge it was given
const issued = new Map<string, { challenge: string; redirectUri: string }>();
const provider = await serve((req, body, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/login/oauth/access_token") {
    const form = Object.fromEntries(new URLSearchParams(body));
    const grant = issued.get(form.code ?? "");
    issued.delete(form.code ?? "");
    const pkce = grant && createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === grant.challenge;
    if (!grant || !pkce || form.redirect_uri !== grant.redirectUri || form.client_secret !== "gh-secret") {
      return json(res, 200, { error: "bad_verification_code" });
    }
    return json(res, 200, { access_token: "gho_ok", token_type: "bearer" });
  }
  if (url.pathname === "/user") return json(res, 200, { id: 42, login: "octocat", name: "Mona" });
  if (url.pathname === "/user/emails") return json(res, 200, [{ email: "ada@example.com", primary: true, verified: true }]);
  json(res, 404, {});
});
after(() => provider.close());

/** What the provider does when the user says yes: a code bound to the challenge, back to the redirect URI. */
function consent(authorizeUrl: string) {
  const u = new URL(authorizeUrl);
  const code = "code-" + Math.random().toString(36).slice(2);
  issued.set(code, { challenge: u.searchParams.get("code_challenge")!, redirectUri: u.searchParams.get("redirect_uri")! });
  return { code, state: u.searchParams.get("state")!, redirectUri: u.searchParams.get("redirect_uri")! };
}

function oauthApp(extra: Record<string, unknown> = {}) {
  const users = makeUsers();
  const profiles: { profile: OAuthUser; provider: string }[] = [];
  const plugin = auth<User>({
    secret: SECRET,
    users: users.source,
    clock: () => clock.t,
    oauth: {
      baseUrl: "http://localhost:3000",
      providers: {
        github: {
          provider: github({ authorizationEndpoint: `${provider.url}/login/oauth/authorize`, tokenEndpoint: `${provider.url}/login/oauth/access_token`, apiUrl: provider.url }),
          clientId: "gh-client",
          clientSecret: "gh-secret",
        },
      },
      onLogin: (profile, id) => {
        profiles.push({ profile, provider: id });
        return profile.emailVerified ? users.list.find((u) => u.email === profile.email) : undefined;
      },
      successRedirect: "/welcome",
      ...extra,
    },
  });
  const app = inkan({ log: false })
    .register(plugin)
    .get("/account", { security: plugin.session }, (ctx) => ({ id: ctx.user!.id }));
  return { app, profiles };
}

const start = async (app: ReturnType<typeof oauthApp>["app"]) => {
  const res = await app.inject({ url: "/auth/oauth/github" });
  return { res, flow: cookieOf(res, "sid_oauth")!, location: res.headers.location };
};

test("OAuth: the whole way, from the redirect to a session", async () => {
  const { app, profiles } = oauthApp();
  const { res, flow, location } = await start(app);
  assert.equal(res.status, 302);
  const auth = new URL(location);
  assert.equal(auth.origin + auth.pathname, `${provider.url}/login/oauth/authorize`);
  assert.equal(auth.searchParams.get("client_id"), "gh-client");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("redirect_uri"), "http://localhost:3000/auth/oauth/github/callback");
  const set = setCookieOf(res, "sid_oauth")!;
  assert.match(set, /; Path=\/auth\/oauth\/github; Max-Age=600; HttpOnly; SameSite=Lax$/);
  assert.ok(!flow.includes(auth.searchParams.get("state")!), "the state is sealed in the cookie, not readable");

  const { code, state } = consent(location);
  const back = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${state}`, headers: { cookie: `sid_oauth=${flow}` } });
  assert.equal(back.status, 302);
  assert.equal(back.headers.location, "/welcome");
  assert.equal(cookieOf(back, "sid_oauth"), "", "the flow cookie is spent");
  const sid = cookieOf(back, "sid");
  assert.ok(sid);
  assert.deepEqual((await app.inject({ url: "/account", headers: { cookie: `sid=${sid}` } })).body, { id: 1 });
  assert.equal(profiles[0].provider, "github");
  assert.deepEqual(profiles[0].profile, { id: "42", login: "octocat", name: "Mona", email: "ada@example.com", emailVerified: true, avatarUrl: null });
});

test("OAuth: a state that does not match, or no flow cookie, is a 400 and no session", async () => {
  const { app } = oauthApp();
  const { flow, location } = await start(app);
  const { code } = consent(location);
  const wrong = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=forged-state-0123456789`, headers: { cookie: `sid_oauth=${flow}` } });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.type, "oauth-state");
  assert.equal(cookieOf(wrong, "sid"), undefined);
  const { state } = consent(location);
  const noCookie = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${state}` });
  assert.equal(noCookie.status, 400);
  const tampered = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${state}`, headers: { cookie: `sid_oauth=${flow.slice(0, -2)}AA` } });
  assert.equal(tampered.status, 400);
});

test("OAuth: the flow expires after ten minutes", async () => {
  const before = clock.t;
  try {
    const { app } = oauthApp();
    const { flow, location } = await start(app);
    const { code, state } = consent(location);
    clock.t += 601_000;
    const res = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${state}`, headers: { cookie: `sid_oauth=${flow}` } });
    assert.equal(res.body.type, "oauth-state");
  } finally {
    clock.t = before;
  }
});

test("OAuth: PKCE, a code from another flow is refused by the provider", async () => {
  const { app } = oauthApp();
  const mine = await start(app);
  const theirs = await start(app);
  // an attacker's code (bound to their challenge) injected into my browser's flow
  const { code } = consent(theirs.location);
  const { state } = consent(mine.location);
  const res = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${state}`, headers: { cookie: `sid_oauth=${mine.flow}` } });
  assert.equal(res.status, 401);
  assert.equal(res.body.type, "oauth-failed");
  assert.equal(cookieOf(res, "sid"), undefined);
});

test("OAuth: onLogin can say no, the provider can say no, and failureRedirect turns problems into redirects", async () => {
  const { app } = oauthApp({ onLogin: () => undefined });
  const { flow, location } = await start(app);
  const { code, state } = consent(location);
  const no = await app.inject({ url: `/auth/oauth/github/callback?code=${code}&state=${state}`, headers: { cookie: `sid_oauth=${flow}` } });
  assert.equal(no.status, 403);
  assert.equal(no.body.type, "oauth-not-allowed");

  const denied = await app.inject({ url: `/auth/oauth/github/callback?error=access_denied`, headers: { cookie: `sid_oauth=${flow}` } });
  assert.equal(denied.body.type, "oauth-denied");

  const soft = oauthApp({ failureRedirect: "/login?from=oauth" });
  const res = await soft.app.inject({ url: `/auth/oauth/github/callback?code=x&state=y` });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/login?from=oauth&error=oauth-state");
});

test("OAuth: an unknown provider is a 400 from the contract", async () => {
  const { app } = oauthApp();
  assert.equal((await app.inject({ url: "/auth/oauth/myspace" })).status, 400);
});
