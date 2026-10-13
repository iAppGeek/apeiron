/** A user the picker offers. The server decides what each may see; this list only names them. */
export type UserInfo = { userId: string; name: string };

/** Mirrors `infra/config/entitlements.json` (a test keeps the two in step). */
export const USERS: readonly UserInfo[] = [
  { userId: 'TRADER1', name: 'Alice Marlowe' },
  { userId: 'TRADER2', name: 'Ben Okafor' },
  { userId: 'TRADER3', name: 'Chloe Tanaka' },
  { userId: 'TRADER4', name: 'Diego Ramirez' },
  { userId: 'TRADER5', name: 'Elena Voss' },
  { userId: 'SUPERVISOR', name: 'Desk Supervisor' },
];

export const USER_STORAGE_KEY = 'apeiron.user';

/** The part of `sessionStorage` the app uses. */
export type UserStorage = Pick<Storage, 'getItem' | 'setItem'>;

const isKnown = (userId: string | null): userId is string => userId !== null && USERS.some((u) => u.userId === userId);

/** The user this tab starts as: `?user=` first, then what the tab remembered, otherwise nobody (the picker opens). */
export function pickInitialUser(search: string, storage: UserStorage | null): string | null {
  const fromUrl = new URLSearchParams(search).get('user');
  if (isKnown(fromUrl)) return fromUrl;
  try {
    const stored = storage?.getItem(USER_STORAGE_KEY) ?? null;
    return isKnown(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Remembers the user for this tab. Storage can be blocked, so a failure is not an error. */
export function rememberUser(storage: UserStorage | null, userId: string): void {
  try {
    storage?.setItem(USER_STORAGE_KEY, userId);
  } catch {
    // The tab simply asks again after a reload.
  }
}
