import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entitledTraders, findUser, mayAct, parseEntitlements, resolveScope, type Entitlements } from './entitlements.js';
import { TRADERS } from './order.js';

const file = (): unknown => JSON.parse(readFileSync(new URL('../../../infra/config/entitlements.json', import.meta.url), 'utf8'));
const loaded = (): Entitlements => {
  const parsed = parseEntitlements(file());
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const user = (id: string): NonNullable<ReturnType<typeof findUser>> => {
  const found = findUser(loaded(), id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
};

describe('entitlements file', () => {
  it('is valid, and gives each trader to one user and every trader to the supervisor', () => {
    const e = loaded();
    expect(e.users.map((u) => u.userId)).toEqual(['TRADER1', 'TRADER2', 'TRADER3', 'TRADER4', 'TRADER5', 'SUPERVISOR']);
    expect(user('TRADER2').traders).toEqual(['T2']);
    expect(user('SUPERVISOR').traders).toEqual(['*']);
    expect(findUser(e, 'NOBODY')).toBeUndefined();
  });

  it('names the same people as the traders', () => {
    for (const t of TRADERS) {
      const u = user(`TRADER${t.traderId.slice(1)}`);
      expect(u.name).toBe(t.traderName);
      expect(u.traders).toEqual([t.traderId]);
    }
  });
});

describe('parseEntitlements', () => {
  it('rejects an empty list, a duplicate user, a missing trader list and a user with several traders', () => {
    for (const bad of [
      { users: [] },
      { users: [{ userId: 'A', name: 'A', traders: ['T1'] }, { userId: 'A', name: 'B', traders: ['T2'] }] },
      { users: [{ userId: 'A', name: 'A', traders: [] }] },
      { users: [{ userId: 'A', name: 'A', traders: ['T1', 'T2'] }] },
      { users: [{ userId: 'A', name: 'A', traders: ['*', 'T2'] }] },
      { nope: true },
    ]) {
      expect(parseEntitlements(bad).ok).toBe(false);
    }
  });

  it('says which user is wrong', () => {
    const r = parseEntitlements({ users: [{ userId: 'A', name: 'A', traders: ['T1', 'T2'] }] });
    expect(r.ok ? '' : r.error).toContain('A must have one trader or ["*"]');
  });
});

describe('scope', () => {
  it('lets a user act on their own traders, and a supervisor on everyone', () => {
    expect(mayAct(user('TRADER1'), 'T1')).toBe(true);
    expect(mayAct(user('TRADER1'), 'T2')).toBe(false);
    expect(mayAct(user('SUPERVISOR'), 'T5')).toBe(true);
  });

  it('lists only the entitled traders', () => {
    expect(entitledTraders(user('TRADER3'), TRADERS).map((t) => t.traderId)).toEqual(['T3']);
    expect(entitledTraders(user('SUPERVISOR'), TRADERS)).toHaveLength(TRADERS.length);
  });

  it('resolves ALL to the user`s own trader, or to everyone for a supervisor', () => {
    expect(resolveScope(user('TRADER4'), 'ALL', TRADERS)).toEqual({ ok: true, scope: 'T4' });
    expect(resolveScope(user('SUPERVISOR'), 'ALL', TRADERS)).toEqual({ ok: true, scope: 'ALL' });
  });

  it('accepts an entitled trader, refuses another with FORBIDDEN and an unknown one with UNKNOWN_TRADER', () => {
    expect(resolveScope(user('TRADER1'), 'T1', TRADERS)).toEqual({ ok: true, scope: 'T1' });
    expect(resolveScope(user('SUPERVISOR'), 'T3', TRADERS)).toEqual({ ok: true, scope: 'T3' });
    expect(resolveScope(user('TRADER1'), 'T2', TRADERS)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(resolveScope(user('TRADER1'), 'T9', TRADERS)).toMatchObject({ ok: false, code: 'UNKNOWN_TRADER', message: 'Unknown trader: T9' });
  });
});
