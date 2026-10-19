// Types: `npx tsc` checks this file; node runs it as an ordinary test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inkan } from "@vxnsin/inkan";
import { auth, type AuthContext } from "../index.js";
import { SECRET } from "./app.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectType = <T extends true>() => {};

type Member = { id: string; roles: string[]; passwordHash: string; nickname: string };
const db = new Map<string, Member>([["m1", { id: "m1", roles: ["admin"], passwordHash: "", nickname: "Ada" }]]);

test("the user type comes from users.find, and ctx.user and ctx.auth carry it", async () => {
  const plugin = auth({
    secret: SECRET,
    users: { find: async (login: string) => db.get(login), byId: async (id: string) => db.get(id) },
    routes: false,
  });
  const app = inkan({ log: false })
    .register(plugin)
    .get("/me", { security: plugin.session }, (ctx) => {
      expectType<Equal<typeof ctx.user, Member | undefined>>();
      expectType<Equal<typeof ctx.auth, AuthContext<Member>>>();
      const user = ctx.auth.require("admin");
      expectType<Equal<typeof user, Member>>();
      return { nickname: user.nickname };
    })
    .get("/x", (ctx) => {
      // @ts-expect-error the user may be undefined
      ctx.user.nickname;
      // @ts-expect-error no such field on Member
      ctx.user?.shoeSize;
      return {};
    });
  assert.equal((await app.inject({ url: "/me" })).status, 401);
});

test("an explicit generic, and meta.auth is typed", () => {
  type Staff = { id: number; roles: string[]; desk: string };
  const plugin = auth<Staff>({ secret: SECRET, users: { byId: async () => undefined } });
  const app = inkan({ log: false }).register(plugin);
  app.get("/desk", { security: plugin.session, meta: { auth: { roles: ["staff"], optional: false } } }, (ctx) => ({ desk: ctx.user?.desk ?? "" }));
  // @ts-expect-error roles is a list of strings
  app.get("/bad", { meta: { auth: { roles: "admin" } } }, () => ({}));
  // @ts-expect-error users.byId must give a Staff
  auth<Staff>({ secret: SECRET, users: { byId: async () => ({ id: "x" }) } });
  assert.throws(() =>
    // @ts-expect-error jwt.secret with an RS algorithm
    auth<Staff>({ secret: SECRET, users: { byId: async () => undefined }, jwt: { secret: SECRET, algorithms: ["RS256"] } }),
  );
  assert.ok(app);
});

test("the plugin's routes reach the typed client: POST /auth/login, under a prefix too", async () => {
  const { client } = await import("@vxnsin/inkan/client");
  const plugin = auth({ secret: SECRET, users: { find: async (login: string) => db.get(login), byId: async (id: string) => db.get(id) } });
  const app = inkan({ log: false }).register(plugin);
  const api = client<typeof app>("http://localhost:1");
  type LoginArgs = Parameters<typeof api.post<"/auth/login">>;
  expectType<Equal<LoginArgs[0], "/auth/login">>();
  const login = () => api.post("/auth/login", { body: { login: "ada", password: "x" } });
  type LoginAnswer = Awaited<ReturnType<typeof login>>;
  const check = (res: LoginAnswer) => {
    if (res.ok) expectType<Equal<typeof res.data.user.roles, string[]>>();
    else if (res.status === 429) expectType<Equal<typeof res.problem.status, number>>();
  };
  // @ts-expect-error login needs a password
  const bad = () => api.post("/auth/login", { body: { login: "ada" } });
  // @ts-expect-error no such route
  const none = () => api.post("/auth/nope", {});
  const me = () => api.get("/auth/me");

  const prefixed = inkan({ log: false }).register(auth({ secret: SECRET, users: { byId: async (id: string) => db.get(id) }, routes: "/session" }), {}, { prefix: "/api" });
  const p = client<typeof prefixed>("http://localhost:1");
  const login2 = () => p.post("/api/session/login", { body: { login: "ada", password: "x" } });
  // @ts-expect-error routes: false defines none
  const off = () => client<typeof offApp>("http://localhost:1").get("/auth/me");
  const offApp = inkan({ log: false }).register(auth({ secret: SECRET, users: { byId: async (id: string) => db.get(id) }, routes: false }));
  assert.ok([check, bad, none, me, login2, off]);
});
