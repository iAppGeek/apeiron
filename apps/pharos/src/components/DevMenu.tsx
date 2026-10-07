import type { CodecName, LoadPreset } from '@apeiron/logos';
import { useEffect, useRef, useState, type ReactElement } from 'react';

export type DevMenuProps = {
  codec: CodecName;
  /** The load preset last set from this page; null until one is chosen. */
  preset: LoadPreset | null;
  presetPending?: boolean;
  disabled?: boolean;
  onCodecChange: (codec: CodecName) => void;
  onPresetChange: (preset: LoadPreset) => void;
};

const CODECS: { value: CodecName; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'msgpack', label: 'MessagePack' },
];

const PRESETS: { value: LoadPreset; label: string }[] = [
  { value: 'medium', label: 'Medium' },
  { value: 'stress', label: 'Stress' },
];

/** Small developer menu: the wire codec toggle (switching re-sends hello) and the mock middleware load preset. */
export function DevMenu({ codec, preset, presetPending, disabled, onCodecChange, onPresetChange }: DevMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    const onPointer = (event: PointerEvent): void => {
      if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return (): void => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <div className="dev-menu" ref={root}>
      <button
        type="button"
        className="button"
        data-testid="dev-menu-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
        }}
      >
        Dev
      </button>
      {open && (
        <div className="dev-popover" role="group" aria-label="Developer options">
          <div className="dev-title">Wire codec</div>
          {CODECS.map((c) => (
            <label key={c.value} className="dev-option">
              <input
                type="radio"
                name="codec"
                value={c.value}
                checked={codec === c.value}
                disabled={disabled}
                onChange={() => {
                  onCodecChange(c.value);
                }}
              />
              {c.label}
            </label>
          ))}
          <div className="dev-title dev-title-gap">Load preset{preset === null ? '' : ` (active: ${preset})`}</div>
          {PRESETS.map((p) => (
            <label key={p.value} className="dev-option">
              <input
                type="radio"
                name="preset"
                value={p.value}
                checked={preset === p.value}
                disabled={disabled || presetPending}
                onChange={() => {
                  onPresetChange(p.value);
                }}
              />
              {p.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
