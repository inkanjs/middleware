// Internal: the few HTTP rules every outgoing request of @inkanjs/auth follows.
import { Buffer } from "node:buffer";
import { AuthError } from "./errors.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Answers larger than this are refused: key sets, tokens and discovery documents are small. */
export const MAX_BODY = 1024 * 1024;

/** A URL to talk to: https, or http only on the loopback (for tests and local providers). */
export function secureUrl(value, what) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${what} is not a URL`);
  }
  if (url.username || url.password) throw new TypeError(`${what} must not carry credentials`);
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url;
  throw new TypeError(`${what} must be https (http only on localhost)`);
}

/** Milliseconds since the epoch from a Date, a number of milliseconds, or the clock. */
export function nowMs(now) {
  if (now === undefined) return Date.now();
  const ms = now instanceof Date ? now.getTime() : now;
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw new TypeError("now must be a Date or milliseconds");
  return ms;
}

/**
 * Fetches and parses a JSON answer, with a timeout, no redirects and a size cap. Network
 * failures and timeouts become `unavailableCode` (502), anything else malformed `badCode`.
 * Returns `{ status, ok, body }`; a non-JSON or oversized body throws.
 */
export async function fetchJson(url, init, { fetch = globalThis.fetch, timeoutMs = 5000, unavailableCode, badCode }) {
  let res;
  try {
    res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (cause) {
    throw new AuthError(unavailableCode, `request to ${new URL(url).host} failed`, { status: 502, cause });
  }
  let text;
  try {
    text = await readCapped(res);
  } catch (cause) {
    throw new AuthError(badCode, `answer from ${new URL(url).host} could not be read`, { status: 502, cause });
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (cause) {
    if (!res.ok) throw new AuthError(unavailableCode, `${new URL(url).host} answered ${res.status}`, { status: 502, cause });
    throw new AuthError(badCode, `answer from ${new URL(url).host} is not JSON`, { status: 502, cause });
  }
  return { status: res.status, ok: res.ok, body };
}

async function readCapped(res) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BODY) throw new Error("body too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw new Error("body too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Whether `v` is a plain JSON object (not null, not an array). */
export function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
