import { URGENCIES, checkAmend, type AmendChanges, type Order, type Urgency } from '@apeiron/logos';
import { useState, type FormEvent, type ReactElement } from 'react';

export type AmendDialogProps = {
  order: Order;
  /** Wall clock in ms, for the end-time check. */
  now?: () => number;
  onSubmit: (changes: AmendChanges) => void;
  onClose: () => void;
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** The value a `datetime-local` input shows for a time, in the browser's zone, to the minute. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fromLocalInput = (value: string): number => new Date(value).getTime();

/**
 * Amends the limit price, quantity, end time and urgency of a working order. The checks are the server's own rules
 * (`checkAmend`), run here only to warn before sending: the order service decides.
 */
export function AmendDialog({ order, now = Date.now, onSubmit, onClose }: AmendDialogProps): ReactElement {
  const initialEnd = toLocalInput(order.endTime);
  const [limit, setLimit] = useState(order.limitPrice === null ? '' : String(order.limitPrice));
  const [qty, setQty] = useState(String(order.orderQty));
  const [end, setEnd] = useState(initialEnd);
  const [urgency, setUrgency] = useState<Urgency>(order.urgency);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const changes: AmendChanges = {};
    const price = limit.trim() === '' ? null : Number(limit);
    if (price !== null && !Number.isFinite(price)) {
      setError('Limit price must be a number');
      return;
    }
    if (price !== order.limitPrice) changes.limitPrice = price;
    const quantity = Number(qty);
    if (qty.trim() === '' || !Number.isFinite(quantity)) {
      setError('Quantity must be a number');
      return;
    }
    if (quantity !== order.orderQty) changes.orderQty = quantity;
    if (end !== initialEnd) {
      const endTime = fromLocalInput(end);
      if (!Number.isFinite(endTime)) {
        setError('End time must be a date and time');
        return;
      }
      changes.endTime = endTime;
    }
    if (urgency !== order.urgency) changes.urgency = urgency;
    const failure = checkAmend(order, changes, now());
    if (failure !== null) {
      setError(failure.message);
      return;
    }
    onSubmit(changes);
  };

  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="amend-title"
        data-testid="amend-dialog"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <h2 id="amend-title">Amend {order.orderId}</h2>
        <p className="modal-note">
          {order.side} {order.currencyPair}, {order.status}. Filled {order.filledQty.toLocaleString()} of {order.orderQty.toLocaleString()}.
        </p>
        <div className="amend-fields">
          <label className="field amend-field">
            <span className="field-label">Limit price (blank for none)</span>
            <input className="select" data-testid="amend-limit" inputMode="decimal" value={limit} onChange={(e) => { setLimit(e.target.value); }} />
          </label>
          <label className="field amend-field">
            <span className="field-label">Quantity</span>
            <input className="select" data-testid="amend-qty" inputMode="numeric" value={qty} onChange={(e) => { setQty(e.target.value); }} />
          </label>
          <label className="field amend-field">
            <span className="field-label">End time</span>
            <input className="select" data-testid="amend-end" type="datetime-local" value={end} onChange={(e) => { setEnd(e.target.value); }} />
          </label>
          <label className="field amend-field">
            <span className="field-label">Urgency</span>
            <select className="select" data-testid="amend-urgency" value={urgency} onChange={(e) => { setUrgency(e.target.value as Urgency); }}>
              {URGENCIES.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error !== null && (
          <p className="amend-error" role="alert" data-testid="amend-error">
            {error}
          </p>
        )}
        <div className="amend-buttons">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button" data-testid="amend-submit">
            Amend
          </button>
        </div>
      </form>
    </div>
  );
}
