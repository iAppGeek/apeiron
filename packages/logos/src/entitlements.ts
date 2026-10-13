import { z } from 'zod';
import type { TraderInfo } from './order.js';
import type { ErrorCode, ParseResult } from './protocol.js';

/** `*` in a user's `traders`: every trader. */
export const ALL_TRADERS = '*';

/** A user of the blotter and the traders whose orders they may see and act on (`['*']` is everyone's). */
export type EntitlementUser = { userId: string; name: string; traders: string[] };
export type Entitlements = { users: EntitlementUser[] };

const userSchema: z.ZodType<EntitlementUser> = z.object({
  userId: z.string().min(1),
  name: z.string().min(1),
  traders: z.array(z.string().min(1)).min(1),
});

/**
 * The shape of `infra/config/entitlements.json`. A blotter scopes each view to one trader or to everyone, so a user
 * has either one trader or `*`; the user ids are unique.
 */
export const entitlementsSchema: z.ZodType<Entitlements> = z
  .object({ users: z.array(userSchema).min(1) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.users.forEach((user, i) => {
      if (seen.has(user.userId)) ctx.addIssue({ code: 'custom', path: ['users', i, 'userId'], message: `duplicate user ${user.userId}` });
      seen.add(user.userId);
      if (user.traders.length > 1) {
        ctx.addIssue({ code: 'custom', path: ['users', i, 'traders'], message: `${user.userId} must have one trader or ["*"]` });
      }
    });
  });

export function parseEntitlements(input: unknown): ParseResult<Entitlements> {
  const result = entitlementsSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
}

export const findUser = (entitlements: Entitlements, userId: string): EntitlementUser | undefined =>
  entitlements.users.find((u) => u.userId === userId);

/** Whether the user may see and act on the orders of `traderId`. */
export const mayAct = (user: EntitlementUser, traderId: string): boolean =>
  user.traders.includes(ALL_TRADERS) || user.traders.includes(traderId);

/** The traders the user is entitled to, for the trader selector. */
export const entitledTraders = (user: EntitlementUser, all: readonly TraderInfo[]): TraderInfo[] =>
  all.filter((t) => mayAct(user, t.traderId));

export type ScopeResult = { ok: true; scope: string } | { ok: false; code: Extract<ErrorCode, 'UNKNOWN_TRADER' | 'FORBIDDEN'>; message: string };

/**
 * The trader scope a view is built for. `ALL` means all of the user's traders: everyone for a user entitled to `*`,
 * otherwise that user's one trader. Anything else must be a known trader the user is entitled to.
 */
export function resolveScope(user: EntitlementUser, traderId: string, all: readonly TraderInfo[]): ScopeResult {
  if (traderId === 'ALL') {
    if (user.traders.includes(ALL_TRADERS)) return { ok: true, scope: 'ALL' };
    return { ok: true, scope: user.traders[0] as string };
  }
  if (!all.some((t) => t.traderId === traderId)) return { ok: false, code: 'UNKNOWN_TRADER', message: `Unknown trader: ${traderId}` };
  if (!mayAct(user, traderId)) return { ok: false, code: 'FORBIDDEN', message: `${user.userId} may not see trader ${traderId}` };
  return { ok: true, scope: traderId };
}
