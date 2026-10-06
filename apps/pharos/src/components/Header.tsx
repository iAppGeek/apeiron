import type { CodecName, TraderInfo } from '@apeiron/logos';
import type { ReactElement } from 'react';
import { DevMenu } from './DevMenu';
import { TraderSelector } from './TraderSelector';

export type HeaderProps = {
  traders: readonly TraderInfo[];
  traderId: string;
  switching?: boolean;
  codec: CodecName;
  ready: boolean;
  onTraderChange: (traderId: string) => void;
  onCodecChange: (codec: CodecName) => void;
};

export function Header({ traders, traderId, switching, codec, ready, onTraderChange, onCodecChange }: HeaderProps): ReactElement {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-name">Apeiron</span>
        <span className="brand-sub">Infinity Blotter</span>
      </div>
      <div className="header-controls">
        <TraderSelector traders={traders} value={traderId} switching={switching} disabled={!ready} onChange={onTraderChange} />
        <DevMenu codec={codec} disabled={!ready} onCodecChange={onCodecChange} />
      </div>
    </header>
  );
}
