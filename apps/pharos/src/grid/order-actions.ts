import { COMMAND_ACTIONS, ORDER_STATUSES, canApplyCommand, type CommandAction, type OrderStatus } from '@apeiron/logos';
import type { DefaultMenuItem, GetContextMenuItemsParams, MenuItemDef } from 'ag-grid-community';

export const ACTION_LABEL: Readonly<Record<CommandAction, string>> = {
  CANCEL: 'Cancel order',
  PAUSE: 'Pause order',
  RESUME: 'Resume order',
};

/** The standard clipboard items every row gets (they need the ClipboardModule). */
export const COPY_ITEMS: readonly DefaultMenuItem[] = ['copy', 'copyWithHeaders'];

/** The order a context menu was opened on. */
export type OrderTarget = { orderId: string; status: OrderStatus };

export type RunCommand = (orderId: string, action: CommandAction) => void;

const isStatus = (value: unknown): value is OrderStatus => (ORDER_STATUSES as readonly unknown[]).includes(value);

/** The order under the menu, or null for a group row, an empty area, or a row that has not loaded. */
export function orderTargetOf(node: GetContextMenuItemsParams['node']): OrderTarget | null {
  if (node === null || node.group === true) return null;
  const data: unknown = node.data;
  if (typeof data !== 'object' || data === null) return null;
  const { orderId, status } = data as { orderId?: unknown; status?: unknown };
  return typeof orderId === 'string' && isStatus(status) ? { orderId, status } : null;
}

function actionItem(target: OrderTarget, action: CommandAction, run: RunCommand): MenuItemDef {
  const enabled = canApplyCommand(target.status, action);
  const name = ACTION_LABEL[action];
  const base: MenuItemDef = {
    name,
    disabled: !enabled,
    tooltip: enabled ? undefined : `${name}: not available while the order is ${target.status}`,
    cssClasses: [`order-action-${action.toLowerCase()}`],
  };
  if (!enabled) return base;
  if (action === 'CANCEL') {
    // Cancelling is final, so it asks first: the item opens a one-entry submenu that holds the confirmation.
    return {
      ...base,
      subMenu: [
        {
          name: `Confirm: cancel ${target.orderId}`,
          cssClasses: ['order-action-confirm'],
          action: (): void => {
            run(target.orderId, 'CANCEL');
          },
        },
      ],
    };
  }
  return {
    ...base,
    action: (): void => {
      run(target.orderId, action);
    },
  };
}

/**
 * The context menu: Cancel, Pause and Resume, each enabled only when the order's current status allows it,
 * then the standard copy items. Group rows and non-order areas get the copy items alone.
 */
export function buildContextMenuItems(target: OrderTarget | null, run: RunCommand): (MenuItemDef | DefaultMenuItem)[] {
  if (target === null) return [...COPY_ITEMS];
  return [...COMMAND_ACTIONS.map((action) => actionItem(target, action, run)), 'separator', ...COPY_ITEMS];
}
