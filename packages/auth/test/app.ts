// What the plugin tests share: a few users, a clock to move, and a cookie jar for inject.
import { inkan, type InjectResponse } from "@vxnsin/inkan";
import { auth, hashPassword, type AuthOptions } from "../index.js";

export const SECRET = "test-secret-that-is-long-enough-0123456789";
export const OTHER_SECRET = "another-secret-that-is-long-enough-987654";
export const FAST = { ln: 14 } as const; // scrypt at its cheapest, so the tests stay quick

export type User = {
  id: number;
  email: string;
  roles: string[];
  passwordHash: string | null;
  totpSecret?: string | null;
  recoveryCodes?: string[] | null;
  plan: string;
};

export const HASH = await hashPassword("correct horse", FAST);

export function makeUsers() {
  const list: User[] = [
    { id: 1, email: "ada@example.com", roles: ["admin"], passwordHash: HASH, plan: "pro" },
    { id: 2, email: "bob@example.com", roles: [], passwordHash: HASH, plan: "free" },
    { id: 3, email: "oauth-only@example.com", roles: [], passwordHash: null, plan: "free" },
  ];
  let finds = 0;
  let byIds = 0;
  return {
    list,
    get finds() {
      return finds;
    },
    get byIds() {
      return byIds;
    },
    source: {
      find: async (login: string) => {
        finds++;
        return list.find((u) => u.email === login.toLowerCase());
      },
      byId: async (id: unknown) => {
        byIds++;
        return list.find((u) => u.id === Number(id));
      },
      setTotpSecret: async (id: unknown, secret: string | null) => {
        list.find((u) => u.id === Number(id))!.totpSecret = secret;
      },
      setRecoveryCodes: async (id: unknown, hashes: string[] | null) => {
        list.find((u) => u.id === Number(id))!.recoveryCodes = hashes;
      },
    },
  };
}

export const clock = { t: Date.UTC(2026, 9, 1, 12, 0, 0) };

export function makeApp(extra: Partial<AuthOptions<User>> = {}, users = makeUsers(), appOptions: { trustProxy?: boolean } = {}) {
  const plugin = auth<User>({ secret: SECRET, users: users.source, password: FAST, clock: () => clock.t, ...extra });
  const app = inkan({ log: false, ...appOptions })
    .register(plugin)
    .get("/public", (ctx) => ({ user: ctx.user?.id ?? null, method: ctx.auth.method ?? null }))
    .get("/maybe", { meta: { auth: { optional: true } } }, (ctx) => ({ user: ctx.user?.id ?? null, method: ctx.auth.method ?? null }))
    .get("/account", { security: plugin.session }, (ctx) => ({ id: ctx.user!.id, plan: ctx.user!.plan }))
    .post("/account", { security: plugin.session }, (ctx) => ({ saved: ctx.user!.id }))
    .get("/admin", { security: plugin.session, meta: { auth: { roles: ["admin"] } } }, (ctx) => ({ admin: ctx.auth.require("admin").email }))
    .get("/members", { meta: { auth: {} } }, (ctx) => ({ id: ctx.user!.id }));
  return { app, plugin, users };
}

/** The value a Set-Cookie header sets for `name`, or undefined; "" when it is cleared. */
export function cookieOf(res: InjectResponse, name: string): string | undefined {
  for (const c of res.cookies) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (pair.slice(0, eq) === name) return decodeURIComponent(pair.slice(eq + 1));
  }
  return undefined;
}

export const setCookieOf = (res: InjectResponse, name: string) => res.cookies.find((c) => c.startsWith(name + "="));

export async function login(app: ReturnType<typeof makeApp>["app"], email = "ada@example.com", extra: Record<string, unknown> = {}) {
  const res = await app.inject({ method: "POST", url: "/auth/login", body: { login: email, password: "correct horse", ...extra } });
  return { res, sid: cookieOf(res, "sid") };
}
