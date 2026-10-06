import { useEffect, type ReactElement } from 'react';
import type { Toast } from '../state/app-store';

export type ToastsProps = {
  toasts: readonly Toast[];
  onDismiss: (id: number) => void;
  /** Milliseconds before a toast dismisses itself. */
  lifetimeMs?: number;
};

function ToastItem({
  toast,
  onDismiss,
  lifetimeMs,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
  lifetimeMs: number;
}): ReactElement {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, lifetimeMs);
    return (): void => {
      clearTimeout(timer);
    };
  }, [toast.id, onDismiss, lifetimeMs]);

  return (
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
      <span>{toast.text}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => {
          onDismiss(toast.id);
        }}
      >
        &times;
      </button>
    </div>
  );
}

export function Toasts({ toasts, onDismiss, lifetimeMs = 8000 }: ToastsProps): ReactElement {
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={onDismiss} lifetimeMs={lifetimeMs} />
      ))}
    </div>
  );
}
