import { ORDER_STATUSES, canApplyCommand, type CommandAction, type OrderStatus } from '@apeiron/logos';
import type { GetContextMenuItemsParams, MenuItemDef } from 'ag-grid-community';
import { describe, expect, it, vi } from 'vitest';
import { ACTION_LABEL, buildContextMenuItems, orderTargetOf, type OrderTarget } from './order-actions';

type Node = GetContextMenuItemsParams['node'];
const nodeOf = (props: Record<string, unknown>): Node => props as unknown as Node;

const itemsFor = (status: OrderStatus, run = vi.fn()): { items: (MenuItemDef | string)[]; run: ReturnType<typeof vi.fn> } => ({
  items: buildContextMenuItems({ orderId: 'ALG00000001', status }, run),
  run,
});
const named = (items: (MenuItemDef | string)[], name: string): MenuItemDef => {
  const found = items.find((i): i is MenuItemDef => typeof i !== 'string' && i.name === name);
  if (found === undefined) throw new Error(`no item ${name}`);
  return found;
};

describe('orderTargetOf', () => {
  it('reads the order id and status from a leaf row', () => {
    expect(orderTargetOf(nodeOf({ group: false, data: { orderId: 'ALG1', status: 'LIVE' } }))).toEqual({ orderId: 'ALG1', status: 'LIVE' });
  });

  it.each([
    ['no node', null],
    ['a group row', nodeOf({ group: true, data: { orderId: 'ALG1', status: 'LIVE' } })],
    ['a row that has not loaded', nodeOf({ group: false, data: undefined })],
    ['an unknown status', nodeOf({ group: false, data: { orderId: 'ALG1', status: 'WEIRD' } })],
    ['a missing order id', nodeOf({ group: false, data: { status: 'LIVE' } })],
  ])('returns null for %s', (_name, node) => {
    expect(orderTargetOf(node)).toBeNull();
  });
});

describe('buildContextMenuItems', () => {
  const ACTIONS: CommandAction[] = ['CANCEL', 'PAUSE', 'RESUME'];

  it.each(ORDER_STATUSES.flatMap((status) => ACTIONS.map((action) => [status, action] as const)))(
    'for a %s order, %s is enabled exactly when the transition is valid',
    (status, action) => {
      const { items } = itemsFor(status);
      expect(named(items, ACTION_LABEL[action]).disabled).toBe(!canApplyCommand(status, action));
    },
  );

  it('lists Cancel, Pause and Resume, then the standard copy items', () => {
    const { items } = itemsFor('LIVE');
    expect(items.map((i) => (typeof i === 'string' ? i : i.name))).toEqual([
      'Cancel order',
      'Pause order',
      'Resume order',
      'separator',
      'copy',
      'copyWithHeaders',
    ]);
  });

  it('enables Cancel and Pause but not Resume on a LIVE order', () => {
    const { items } = itemsFor('LIVE');
    expect([named(items, 'Cancel order'), named(items, 'Pause order'), named(items, 'Resume order')].map((i) => i.disabled)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('disables everything on FILLED and CANCELLED orders, with a reason in the tooltip', () => {
    for (const status of ['FILLED', 'CANCELLED'] as const) {
      const { items } = itemsFor(status);
      for (const label of Object.values(ACTION_LABEL)) {
        const item = named(items, label);
        expect(item.disabled).toBe(true);
        expect(item.tooltip).toContain(status);
        expect(item.action).toBeUndefined();
        expect(item.subMenu).toBeUndefined();
      }
    }
  });

  it('runs Pause and Resume immediately, with no confirmation', () => {
    const live = itemsFor('LIVE');
    named(live.items, 'Pause order').action?.({} as never);
    expect(live.run).toHaveBeenCalledExactlyOnceWith('ALG00000001', 'PAUSE');
    const paused = itemsFor('PAUSED');
    named(paused.items, 'Resume order').action?.({} as never);
    expect(paused.run).toHaveBeenCalledExactlyOnceWith('ALG00000001', 'RESUME');
  });

  it('asks before cancelling: the item only opens a confirmation, which runs the command', () => {
    const { items, run } = itemsFor('PENDING_START');
    const cancel = named(items, 'Cancel order');
    expect(cancel.action).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    const confirm = cancel.subMenu?.[0] as MenuItemDef;
    expect(confirm.name).toBe('Confirm: cancel ALG00000001');
    expect(cancel.subMenu).toHaveLength(1);
    confirm.action?.({} as never);
    expect(run).toHaveBeenCalledExactlyOnceWith('ALG00000001', 'CANCEL');
  });

  it('gives a group row or an empty area the copy items only', () => {
    expect(buildContextMenuItems(null, vi.fn())).toEqual(['copy', 'copyWithHeaders']);
  });

  it('builds fresh items from the status at the time the menu opens', () => {
    const target: OrderTarget = { orderId: 'A', status: 'LIVE' };
    expect(named(buildContextMenuItems(target, vi.fn()), 'Pause order').disabled).toBe(false);
    expect(named(buildContextMenuItems({ ...target, status: 'PAUSED' }, vi.fn()), 'Pause order').disabled).toBe(true);
  });
});
