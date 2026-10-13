import type { ReactElement } from 'react';
import type { UserInfo } from '../state/users';

export type UserSelectorProps = {
  users: readonly UserInfo[];
  value: string;
  disabled?: boolean;
  onChange: (userId: string) => void;
};

export function UserSelector({ users, value, disabled, onChange }: UserSelectorProps): ReactElement {
  return (
    <label className="field">
      <span className="field-label">User</span>
      <select
        className="select"
        data-testid="user-select"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {users.map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.name}
          </option>
        ))}
      </select>
    </label>
  );
}
