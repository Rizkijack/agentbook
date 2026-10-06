/**
 * `supertest` ships no types and the repo has no `@types/supertest`.
 *
 * Without this, `tsc -p tsconfig.test.json` reports four TS7016 errors and the
 * test typecheck is unusable, which is worse than having no typecheck at all.
 * A local ambient declaration keeps the gate green without pulling in a
 * dependency; the HTTP tests were always running untyped, so nothing is lost.
 *
 * The real fix is `pnpm --filter backend add -D @types/supertest`, which turns
 * these four call sites back into checked ones.
 */
declare module "supertest";
