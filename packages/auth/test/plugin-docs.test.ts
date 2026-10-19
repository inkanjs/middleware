import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan, t } from "@vxnsin/inkan";
import { auth, github } from "../index.js";
import { FAST, SECRET, makeUsers, type User } from "./app.ts";

function fullApp() {
  const users = makeUsers();
  const plugin = auth({
    secret: SECRET,
    users: users.source,
    password: FAST,
    jwt: { issue: true },
    apiKeys: { verify: () => undefined },
    totp: { issuer: "Tea" },
    oauth: {
      baseUrl: "https://app.example",
      providers: { github: { provider: github(), clientId: "c" } },
      onLogin: () => undefined,
    },
  });
  const app = inkan({ log: false, title: "Tea" })
    .register(plugin)
    .get("/admin/stats", { security: "bearer", meta: { auth: { roles: ["admin"] } }, response: { 200: t.object({ n: t.int() }) } }, () => ({ n: 1 }))
    .post("/notes", { security: plugin.session, response: { 200: t.object({ ok: t.boolean() }) } }, () => ({ ok: true }))
    .get("/members", { meta: { auth: { roles: ["member"] } } }, () => ({}));
  return { app, plugin };
}

test("OpenAPI: the generated routes, scheme details and 403s", async () => {
  const { app } = fullApp();
  await app.ready();
  const doc = app.openapi() as any;
  const paths = Object.entries(doc.paths).flatMap(([p, ops]) => Object.keys(ops as object).map((m) => `${m.toUpperCase()} ${p}`));
  for (const route of [
    "POST /auth/login",
    "POST /auth/logout",
    "GET /auth/me",
    "POST /auth/token",
    "POST /auth/token/refresh",
    "POST /auth/totp/setup",
    "POST /auth/totp/confirm",
    "POST /auth/totp/disable",
    "GET /auth/oauth/{provider}",
    "GET /auth/oauth/{provider}/callback",
  ]) {
    assert.ok(paths.includes(route), `${route} is documented`);
  }
  const schemes = doc.components.securitySchemes;
  assert.deepEqual(schemes.bearer, { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "An access token from POST /auth/token" });
  assert.deepEqual(schemes["sid-cookie"], { type: "apiKey", in: "cookie", name: "sid", description: "The session cookie that logging in sets" });

  const stats = doc.paths["/admin/stats"].get;
  assert.equal(stats.responses["403"].description, "Needs one of the roles admin");
  assert.equal(stats.responses["403"].content["application/problem+json"].schema.$ref, "#/components/schemas/Problem");
  assert.ok(doc.components.schemas.Problem);
  assert.match(doc.paths["/notes"].post.responses["403"].description, /csrf/);
  assert.equal(doc.paths["/members"].get.responses["401"].description, "Not logged in");
  assert.deepEqual(doc.paths["/auth/me"].get.security, [{ "sid-cookie": [] }, { bearer: [] }]);
  assert.deepEqual(doc.paths["/auth/oauth/{provider}"].get.parameters[0].schema, { const: "github" });
  assert.equal(doc.paths["/auth/login"].post.requestBody.content["application/json"].schema.properties.password.type, "string");
  assert.equal(doc.paths["/auth/me"].get.responses["403"], undefined, "a GET is no CSRF target");
});

test("inkan check: every generated route has an example, and they all pass", async () => {
  const { app } = fullApp();
  const report = await app.check();
  const ours = report.results.filter((r) => r.path.startsWith("/auth"));
  assert.equal(ours.length, 10);
  for (const r of ours) assert.ok(r.ok, `${r.method} ${r.path} > ${r.example}: ${r.problems.join("; ")}`);
  assert.deepEqual(report.unchecked.filter((u) => u.includes("/auth")), []);
});

test("inkan check passes with failureRedirect too, and under a prefix", async () => {
  const users = makeUsers();
  const plugin = auth<User>({
    secret: SECRET,
    users: users.source,
    password: FAST,
    oauth: { baseUrl: "https://app.example", github: { clientId: "c" }, onLogin: () => undefined, failureRedirect: "/login" },
  });
  const app = inkan({ log: false }).register(plugin, {}, { prefix: "/api" });
  const report = await app.check();
  assert.ok(report.ok, JSON.stringify(report.results.filter((r) => !r.ok)));
  assert.ok(report.results.some((r) => r.path === "/api/auth/oauth/:provider/callback"));
  const start = await app.inject({ url: "/api/auth/oauth/github" });
  assert.equal(new URL(start.headers.location).searchParams.get("redirect_uri"), "https://app.example/api/auth/oauth/github/callback");
});

test("inkan check with an example account: logs in, then /me and /logout with the session cookie", async () => {
  for (const prefix of ["", "/api"]) {
    const users = makeUsers();
    const plugin = auth<User>({ secret: SECRET, users: users.source, password: FAST, example: { login: "bob@example.com", password: "correct horse" } });
    const app = inkan({ log: false }).register(plugin, {}, { prefix });
    const report = await app.check();
    assert.ok(report.ok, JSON.stringify(report.results.filter((r) => !r.ok)));
    const names = report.results.map((r) => `${r.method} ${r.path} > ${r.example}`);
    for (const name of [`POST ${prefix}/auth/login > a known login`, `GET ${prefix}/auth/me > after logging in`, `POST ${prefix}/auth/logout > after logging in`]) {
      assert.ok(names.includes(name), `${name} in ${names.join(", ")}`);
    }
  }
  // a wrong example password is a failing check, so the chain really logs in
  const wrong = inkan({ log: false }).register(auth<User>({ secret: SECRET, users: makeUsers().source, password: FAST, example: { login: "bob@example.com", password: "nope" } }));
  const failed = (await wrong.check()).results.filter((r) => !r.ok).map((r) => `${r.method} ${r.path} > ${r.example}`);
  assert.ok(failed.includes("POST /auth/login > a known login"), failed.join(", "));
  assert.throws(() => auth<User>({ secret: SECRET, users: makeUsers().source, example: { login: "x" } as never }), /example needs/);
});
