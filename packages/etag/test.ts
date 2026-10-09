import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { compress, inkan, reply, t } from "@vxnsin/inkan";
import { etag, etagOf, noneMatch } from "./index.js";

const quiet = { log: false as const };
const sha1 = (s: string | Buffer) => `"${createHash("sha1").update(s).digest("base64url")}"`;

const Tea = t.object({ id: t.number(), name: t.string() });
const teas = () =>
  inkan(quiet)
    .register(etag())
    // the contract writes only id and name: the tag has to be of that, not of the object
    .get("/teas/:id", { response: { 200: Tea } }, (ctx) => ({ id: Number(ctx.params.id), name: "Sencha", secret: "never sent" }) as never)
    .get("/text", (ctx) => ctx.text("hello wörld"))
    .get("/bytes", () => Buffer.from([1, 2, 3]))
    .get("/own", () => reply(200, { a: 1 }, { etag: '"v42"' }))
    .get("/none", () => undefined)
    .get("/stream", () => (async function* () { yield "a"; })())
    .get("/missing", (ctx) => ctx.notFound())
    .get("/created", () => reply(201, { id: 1 }))
    .get("/guarded", { headers: t.object({ "x-tenant": t.string() }) }, () => ({ ok: 1 }))
    .post("/teas", () => ({ id: 1 }));

test("the tag is a hash of exactly the bytes that are sent", async () => {
  const app = teas();
  const r = await app.inject({ url: "/teas/1" });
  assert.equal(r.text, '{"id":1,"name":"Sencha"}');
  assert.equal(r.headers.etag, sha1(r.text));
  assert.equal((await app.inject({ url: "/text" })).headers.etag, sha1(Buffer.from("hello wörld", "utf8")));
  assert.equal((await app.inject({ url: "/bytes" })).headers.etag, sha1(Buffer.from([1, 2, 3])));
  assert.equal((await app.inject({ url: "/created" })).headers.etag, sha1('{"id":1}'), "any 2xx");
  assert.equal((await app.inject({ url: "/teas/2" })).headers.etag !== r.headers.etag, true);
});

test("If-None-Match that names it: 304, no body, the tag kept", async () => {
  const app = teas();
  const { headers } = await app.inject({ url: "/teas/1" });
  const tag = headers.etag!;
  const r = await app.inject({ url: "/teas/1", headers: { "if-none-match": tag } });
  assert.equal(r.status, 304);
  assert.equal(r.text, "");
  assert.equal(r.headers.etag, tag);
  assert.equal(r.headers["content-type"], undefined);
  assert.equal(r.headers["content-length"], undefined);

  for (const header of [`"x", ${tag}`, `W/${tag}`, `"a","b" , W/${tag}`, "*"]) {
    assert.equal((await app.inject({ url: "/teas/1", headers: { "if-none-match": header } })).status, 304, header);
  }
  for (const header of ['"x"', tag.slice(0, -2) + '"', "W/\"nope\", \"other\"", ""]) {
    assert.equal((await app.inject({ url: "/teas/1", headers: { "if-none-match": header } })).status, 200, header);
  }
});

test("HEAD gets the tag and the 304 too", async () => {
  const app = teas();
  const tag = (await app.inject({ url: "/teas/1" })).headers.etag!;
  const head = await app.inject({ method: "HEAD", url: "/teas/1" });
  assert.equal(head.headers.etag, tag);
  assert.equal(head.headers["content-length"], String(Buffer.byteLength('{"id":1,"name":"Sencha"}')));
  assert.equal((await app.inject({ method: "HEAD", url: "/teas/1", headers: { "if-none-match": tag } })).status, 304);
});

test("left alone: other methods, problems, no body, streams; a tag of the handler's own is kept and compared", async () => {
  const app = teas();
  assert.equal((await app.inject({ method: "POST", url: "/teas" })).headers.etag, undefined);
  assert.equal((await app.inject({ url: "/missing" })).headers.etag, undefined);
  assert.equal((await app.inject({ url: "/none" })).headers.etag, undefined);
  assert.equal((await app.inject({ url: "/stream" })).headers.etag, undefined);
  assert.equal((await app.inject({ method: "POST", url: "/teas", headers: { "if-none-match": "*" } })).status, 200, "If-None-Match on a POST is not ours");

  const own = await app.inject({ url: "/own" });
  assert.equal(own.headers.etag, '"v42"');
  assert.equal((await app.inject({ url: "/own", headers: { "if-none-match": '"v42"' } })).status, 304);
});

test("a header schema on the route does not hide If-None-Match", async () => {
  const app = teas();
  const tag = (await app.inject({ url: "/guarded", headers: { "x-tenant": "a" } })).headers.etag!;
  assert.equal((await app.inject({ url: "/guarded", headers: { "x-tenant": "a", "if-none-match": tag } })).status, 304);
});

test("weak: W/ in front, and a strong If-None-Match still matches it", async () => {
  const app = inkan(quiet).register(etag({ weak: true })).get("/x", () => ({ a: 1 }));
  const r = await app.inject({ url: "/x" });
  assert.equal(r.headers.etag, "W/" + sha1('{"a":1}'));
  assert.equal((await app.inject({ url: "/x", headers: { "if-none-match": sha1('{"a":1}') } })).status, 304);
});

test("with compress: the tag of the unpacked body, the same for every encoding, and 304 still works", async () => {
  const big = { text: "sencha ".repeat(500) };
  const raw = JSON.stringify(big);
  // etag registered after compress, and the other way round: compress always runs last
  for (const app of [
    inkan(quiet).register(compress()).register(etag()).get("/big", () => big),
    inkan(quiet).register(etag()).register(compress()).get("/big", () => big),
  ]) {
    const gz = await app.inject({ url: "/big", headers: { "accept-encoding": "gzip" } });
    const br = await app.inject({ url: "/big", headers: { "accept-encoding": "br" } });
    const plain = await app.inject({ url: "/big" });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.equal(br.headers["content-encoding"], "br");
    assert.equal(gz.headers.etag, sha1(raw));
    assert.equal(br.headers.etag, sha1(raw));
    assert.equal(plain.headers.etag, sha1(raw));
    assert.equal(gz.text, raw, "the body is still packed and whole");

    const again = await app.inject({ url: "/big", headers: { "accept-encoding": "gzip", "if-none-match": gz.headers.etag! } });
    assert.equal(again.status, 304);
    assert.equal(again.headers["content-encoding"], undefined, "nothing to pack");
    assert.equal(again.text, "");
  }
});

test("only in the scope it is registered in", async () => {
  const app = inkan(quiet)
    .register((scope) => {
      scope.register(etag());
      scope.get("/in", () => ({}));
    })
    .get("/out", () => ({}));
  assert.ok((await app.inject({ url: "/in" })).headers.etag);
  assert.equal((await app.inject({ url: "/out" })).headers.etag, undefined);
});

test("the helpers", () => {
  assert.equal(etagOf("abc"), sha1("abc"));
  assert.equal(etagOf("abc", true), "W/" + sha1("abc"));
  assert.equal(noneMatch('W/"a"', '"a"'), true);
  assert.equal(noneMatch('"a"', 'W/"a"'), true);
  assert.equal(noneMatch('"a,b", "c"', '"a,b"'), true, "a comma inside a tag");
  assert.equal(noneMatch('"ab"', '"a"'), false);
  assert.equal(noneMatch(" * ", '"a"'), true);
});
