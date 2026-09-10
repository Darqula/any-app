/**
 * Who a row belongs to. A signed-in browser carries both — `userId` owns the data,
 * `sessionId` is still the cookie it arrived on (claim.ts's `claimAnonymousWork` needs both
 * at once).
 */
export type Owner =
  | { kind: "user"; userId: string; sessionId: string }
  | { kind: "anon"; sessionId: string };

/** `WHERE` fragment plus its parameter, so every scoped query is written the same way. */
export function ownerFilter(owner: Owner, paramIndex: number): { sql: string; param: string } {
  return owner.kind === "user"
    ? { sql: `owner_id = $${paramIndex}`, param: owner.userId }
    : { sql: `owner_id is null and session_id = $${paramIndex}`, param: owner.sessionId };
}
