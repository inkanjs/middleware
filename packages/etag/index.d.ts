import type { Plugin } from "@vxnsin/inkan";

export type EtagOptions = {
  /** `W/"…"` instead of a strong tag. Default false. */
  weak?: boolean;
};

/**
 * An ETag on every 2xx answer to GET and HEAD whose body is whole, hashed from exactly the
 * bytes the handler's answer has, and 304 Not Modified when If-None-Match names it.
 * Shared: register it on the app or the scope whose routes it serves.
 */
export declare function etag(options?: EtagOptions): Plugin<{}, {}, {}>;
export default etag;

/** The tag of a body: SHA-1, base64url, quoted; `W/` in front for a weak one. */
export declare function etagOf(body: string | Uint8Array, weak?: boolean): string;

/** Whether an If-None-Match header names this tag, by weak comparison (RFC 9110). `*` names any. */
export declare function noneMatch(header: string, tag: string): boolean;
