import { parseEntitlements, type Entitlements } from '@apeiron/logos';

/** The users of `infra/config/entitlements.json`, for tests. */
const parsed = parseEntitlements({
  users: [
    { userId: 'TRADER1', name: 'Alice Marlowe', traders: ['T1'] },
    { userId: 'TRADER2', name: 'Ben Okafor', traders: ['T2'] },
    { userId: 'TRADER3', name: 'Chloe Tanaka', traders: ['T3'] },
    { userId: 'TRADER4', name: 'Diego Ramirez', traders: ['T4'] },
    { userId: 'TRADER5', name: 'Elena Voss', traders: ['T5'] },
    { userId: 'SUPERVISOR', name: 'Desk Supervisor', traders: ['*'] },
  ],
});
if (!parsed.ok) throw new Error(parsed.error);
export const testEntitlements: Entitlements = parsed.value;
