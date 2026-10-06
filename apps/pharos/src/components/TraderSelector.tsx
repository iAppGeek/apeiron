import type { TraderInfo } from '@apeiron/logos';
import type { ReactElement } from 'react';

export type TraderSelectorProps = {
  traders: readonly TraderInfo[];
  value: string;
  disabled?: boolean;
  onChange: (traderId: string) => void;
};

export function TraderSelector({ traders, value, disabled, onChange }: TraderSelectorProps): ReactElement {
  return (
    <label className="field">
      <span className="field-label">Trader</span>
      <select
        className="select"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="ALL">All traders</option>
        {traders.map((t) => (
          <option key={t.traderId} value={t.traderId}>
            {t.traderName}
          </option>
        ))}
      </select>
    </label>
  );
}
