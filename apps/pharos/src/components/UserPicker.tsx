import type { ReactElement } from 'react';
import type { UserInfo } from '../state/users';

export type UserPickerProps = {
  users: readonly UserInfo[];
  onPick: (userId: string) => void;
};

/** Shown on first load, until this tab has a user. There are no passwords: it only says who is looking. */
export function UserPicker({ users, onPick }: UserPickerProps): ReactElement {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="user-picker-title" data-testid="user-picker">
        <h2 id="user-picker-title">Who is looking?</h2>
        <p className="modal-note">Each user sees only their own trader&apos;s orders. The supervisor sees everyone&apos;s.</p>
        <ul className="modal-list">
          {users.map((u) => (
            <li key={u.userId}>
              <button
                type="button"
                className="button modal-user"
                data-testid={`pick-${u.userId}`}
                onClick={() => {
                  onPick(u.userId);
                }}
              >
                {u.name}
                <span className="modal-user-id">{u.userId}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
