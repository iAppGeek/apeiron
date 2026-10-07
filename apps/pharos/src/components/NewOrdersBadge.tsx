import type { ReactElement } from 'react';

export type NewOrdersBadgeProps = {
  count: number;
  onClick: () => void;
};

/** Floating "N new orders" badge shown while the viewport is scrolled below newly arrived rows. */
export function NewOrdersBadge({ count, onClick }: NewOrdersBadgeProps): ReactElement | null {
  if (count <= 0) return null;
  const label = `${new Intl.NumberFormat('en-US').format(count)} new ${count === 1 ? 'order' : 'orders'}`;
  return (
    <button type="button" className="new-orders-badge" data-testid="new-orders-badge" onClick={onClick}>
      {label} <span aria-hidden="true">↑</span>
    </button>
  );
}
