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
