import { timingSafeEqual } from "node:crypto";

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `===` on strings short-circuits at the first differing byte, so a caller that
 * can time the response learns the shared prefix one character at a time. This
 * walks both strings in full regardless. The length comparison is done by the
 * caller first, because `timingSafeEqual` throws on a length mismatch and the
 * length of a key is not the secret.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}