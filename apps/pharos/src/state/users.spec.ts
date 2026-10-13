import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { USERS, USER_STORAGE_KEY, pickInitialUser, rememberUser, type UserStorage } from './users';

const storageWith = (value: string | null): UserStorage => ({ getItem: vi.fn(() => value), setItem: vi.fn() });

describe('USERS', () => {
  it('lists the users of the entitlements file, in order', () => {
    const file = JSON.parse(readFileSync(resolve(process.cwd(), '../../infra/config/entitlements.json'), 'utf8')) as {
      users: { userId: string; name: string }[];
    };
    expect(USERS).toEqual(file.users.map(({ userId, name }) => ({ userId, name })));
  });
});

describe('pickInitialUser', () => {
  it('prefers ?user= over what the tab remembered, and ignores an unknown name', () => {
    expect(pickInitialUser('?user=TRADER2', storageWith('TRADER1'))).toBe('TRADER2');
    expect(pickInitialUser('?user=GHOST', storageWith('TRADER1'))).toBe('TRADER1');
    expect(pickInitialUser('', storageWith('SUPERVISOR'))).toBe('SUPERVISOR');
  });

  it('returns null when nothing names a known user, or storage is unavailable', () => {
    expect(pickInitialUser('', storageWith(null))).toBeNull();
    expect(pickInitialUser('', storageWith('GHOST'))).toBeNull();
    expect(pickInitialUser('', null)).toBeNull();
    expect(pickInitialUser('', { getItem: () => { throw new Error('blocked'); }, setItem: vi.fn() })).toBeNull();
  });
});

describe('rememberUser', () => {
  it('stores the user under the tab key, and survives blocked storage', () => {
    const storage = storageWith(null);
    rememberUser(storage, 'TRADER3');
    expect(storage.setItem).toHaveBeenCalledWith(USER_STORAGE_KEY, 'TRADER3');
    expect(() => rememberUser({ getItem: vi.fn(), setItem: () => { throw new Error('full'); } }, 'TRADER3')).not.toThrow();
    expect(() => rememberUser(null, 'TRADER3')).not.toThrow();
  });
});
