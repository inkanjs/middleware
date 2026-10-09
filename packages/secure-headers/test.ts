import { test } from "node:test";
import assert from "node:assert/strict";
import { html, inkan, problem, reply } from "@vxnsin/inkan";
import { DEFAULT_CSP, secureHeaders } from "./index.js";

const quiet = { log: false as const };
const CSP = "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self'";

test("every answer gets the defaults, problems too", async () => {
  const app = inkan(quiet)
    .register(secureHeaders())
    .get("/x", () => ({ ok: 1 }))
    .get("/boom", () => {
      throw problem(409, "conflict");
    });
  for (const url of ["/x", "/boom", "/nowhere"]) {
    const r = await app.inject({ url });
    assert.equal(r.headers["content-security-policy"], CSP, url);
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(r.headers["x-dns-prefetch-control"], "off");
    assert.match(r.headers["permissions-policy"]!, /^camera=\(\), geolocation=\(\)/);
    assert.equal(r.headers["strict-transport-security"], undefined, "plain HTTP: no HSTS");
  }
  assert.ok(Object.isFrozen(DEFAULT_CSP));
});

test("each header can be changed or left out, and a header the handler set wins", async () => {
  const app = inkan(quiet)
    .register(
      secureHeaders({
        frameOptions: "SAMEORIGIN",
        referrerPolicy: false,
        crossOriginResourcePolicy: "cross-origin",
        permissionsPolicy: false,
        extra: { "X-Robots-Tag": "noindex" },
        csp: { directives: { imgSrc: ["'self'", "https://cdn.example.com"], "script-src-attr": false, "upgrade-insecure-requests": true } },
      }),
    )
    .get("/x", () => ({ ok: 1 }))
    .get("/own", () => reply(200, { ok: 1 }, { "x-frame-options": "ALLOW-FROM https://example.com", "content-security-policy": "default-src 'none'" }));
  const r = await app.inject({ url: "/x" });
  assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
  assert.equal(r.headers["referrer-policy"], undefined);
  assert.equal(r.headers["permissions-policy"], undefined);
  assert.equal(r.headers["cross-origin-resource-policy"], "cross-origin");
  assert.equal(r.headers["x-robots-tag"], "noindex");
  assert.match(r.headers["content-security-policy"]!, /img-src 'self' https:\/\/cdn\.example\.com;/);
  assert.doesNotMatch(r.headers["content-security-policy"]!, /script-src-attr/);
  assert.match(r.headers["content-security-policy"]!, /; upgrade-insecure-requests$/);

  const own = await app.inject({ url: "/own" });
  assert.equal(own.headers["x-frame-options"], "ALLOW-FROM https://example.com");
  assert.equal(own.headers["content-security-policy"], "default-src 'none'");
});

test("csp: false, report-only, and a policy of your own from nothing", async () => {
  const off = inkan(quiet).register(secureHeaders({ csp: false })).get("/x", () => ({}));
  const r = await off.inject({ url: "/x" });
  assert.equal(r.headers["content-security-policy"], undefined);
  assert.equal(r.headers["x-content-type-options"], "nosniff", "the rest stays");

  const report = inkan(quiet).register(secureHeaders({ csp: { reportOnly: true } })).get("/x", () => ({}));
  const rr = await report.inject({ url: "/x" });
  assert.equal(rr.headers["content-security-policy-report-only"], CSP);
  assert.equal(rr.headers["content-security-policy"], undefined);

  const own = inkan(quiet).register(secureHeaders({ csp: { useDefaults: false, directives: { "default-src": "'none'", "frame-ancestors": "'none'" } } })).get("/x", () => ({}));
  assert.equal((await own.inject({ url: "/x" })).headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'");
});

test("ctx.cspNonce: fresh per request, and only in the policy of an answer that read it", async () => {
  const app = inkan(quiet)
    .register(secureHeaders())
    .get("/page", (ctx) => html`<script nonce="${ctx.cspNonce}">go()</script><style nonce="${ctx.cspNonce}">p{}</style>`)
    .get("/plain", () => ({ ok: 1 }));
  const a = await app.inject({ url: "/page" });
  const b = await app.inject({ url: "/page" });
  const nonce = /nonce="([^"]+)"/.exec(a.text)![1]!;
  assert.match(nonce, /^[A-Za-z0-9+/]{22}==$/, "128 random bits");
  assert.notEqual(nonce, /nonce="([^"]+)"/.exec(b.text)![1]);
  const policy = a.headers["content-security-policy"]!;
  assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce.replace(/[+/]/g, "\\$&")}'`));
  assert.match(policy, new RegExp(`style-src 'self' 'nonce-${nonce.replace(/[+/]/g, "\\$&")}'`));
  assert.equal((await app.inject({ url: "/plain" })).headers["content-security-policy"], CSP, "no nonce read, none sent");

  // typed for the routes after register()
  inkan(quiet).register(secureHeaders()).get("/t", (ctx) => ctx.cspNonce.length);
});

test("a nonce goes into script-src even when only default-src was there", async () => {
  const app = inkan(quiet)
    .register(secureHeaders({ csp: { useDefaults: false, directives: { "default-src": "'self'" } } }))
    .get("/page", (ctx) => html`<script nonce="${ctx.cspNonce}"></script>`);
  const r = await app.inject({ url: "/page" });
  assert.match(r.headers["content-security-policy"]!, /^default-src 'self'; script-src 'self' 'nonce-[^']+'; style-src 'self' 'nonce-[^']+'$/);
});

test("hsts: over HTTPS, or always with force, never twice", async () => {
  const always = inkan(quiet).register(secureHeaders({ hsts: { force: true, preload: true } })).get("/x", () => ({}));
  assert.equal((await always.inject({ url: "/x" })).headers["strict-transport-security"], "max-age=31536000; includeSubDomains; preload");

  const behindProxy = inkan(quiet)
    .register(secureHeaders({ https: (ctx) => (ctx.headers as Record<string, string>)["x-forwarded-proto"] === "https", hsts: { maxAge: 600, includeSubDomains: false } }))
    .get("/x", () => ({}));
  assert.equal((await behindProxy.inject({ url: "/x", headers: { "x-forwarded-proto": "https" } })).headers["strict-transport-security"], "max-age=600");
  assert.equal((await behindProxy.inject({ url: "/x" })).headers["strict-transport-security"], undefined);

  const off = inkan(quiet).register(secureHeaders({ hsts: false, https: () => true })).get("/x", () => ({}));
  assert.equal((await off.inject({ url: "/x" })).headers["strict-transport-security"], undefined);
});

test("only the scope it is registered in, and skip leaves answers alone", async () => {
  const app = inkan(quiet)
    .register(
      (scope) => {
        scope.register(secureHeaders({ skip: (ctx) => ctx.path === "/app/embed" }));
        scope.get("/app/page", () => ({}));
        scope.get("/app/embed", () => ({}));
      },
    )
    .get("/api/x", () => ({}));
  assert.ok((await app.inject({ url: "/app/page" })).headers["content-security-policy"]);
  assert.equal((await app.inject({ url: "/app/embed" })).headers["content-security-policy"], undefined);
  assert.equal((await app.inject({ url: "/api/x" })).headers["x-frame-options"], undefined, "outside the scope");
});

test("inkan's docs page and inspector keep working: they are answered before any hook", async () => {
  const app = inkan({ ...quiet, docs: "/docs", inspector: "/_inkan" })
    .register(secureHeaders({ hsts: { force: true } }))
    .get("/x", () => ({}));
  await app.ready();
  for (const url of ["/docs", "/_inkan", "/openapi.json"]) {
    const r = await app.fetch(new Request("http://localhost" + url), { remote: "127.0.0.1" });
    assert.equal(r.status, 200, url);
    assert.equal(r.headers.get("content-security-policy"), null, `${url} keeps its inline script and style`);
  }
  const docs = await (await app.fetch(new Request("http://localhost/docs"), { remote: "127.0.0.1" })).text();
  assert.match(docs, /<script>/, "the docs page runs an inline script, which the default policy would block");
  assert.match(docs, /<style>/);
});
