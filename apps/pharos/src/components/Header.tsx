import type { CodecName, LoadPreset, TraderInfo } from '@apeiron/logos';
import type { ReactElement } from 'react';
import { DevMenu } from './DevMenu';
import type { UserInfo } from '../state/users';
import { TraderSelector } from './TraderSelector';
import { UserSelector } from './UserSelector';

export type HeaderProps = {
  users: readonly UserInfo[];
  userId: string;
  traders: readonly TraderInfo[];
  traderId: string;
  switching?: boolean;
  codec: CodecName;
  ready: boolean;
  preset: LoadPreset | null;
  presetPending?: boolean;
  onUserChange: (userId: string) => void;
  onTraderChange: (traderId: string) => void;
  onCodecChange: (codec: CodecName) => void;
  onPresetChange: (preset: LoadPreset) => void;
};

export function Header({
  users,
  userId,
  traders,
  traderId,
  switching,
  codec,
  ready,
  preset,
  presetPending,
  onUserChange,
  onTraderChange,
  onCodecChange,
  onPresetChange,
}: HeaderProps): ReactElement {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-name">Apeiron</span>
        <span className="brand-sub">Infinity Blotter</span>
      </div>
      <div className="header-controls">
        <UserSelector users={users} value={userId} disabled={!ready} onChange={onUserChange} />
        <TraderSelector traders={traders} value={traderId} switching={switching} disabled={!ready} onChange={onTraderChange} />
        <DevMenu
          codec={codec}
          preset={preset}
          presetPending={presetPending}
          disabled={!ready}
          onCodecChange={onCodecChange}
          onPresetChange={onPresetChange}
        />
      </div>
    </header>
  );
}
