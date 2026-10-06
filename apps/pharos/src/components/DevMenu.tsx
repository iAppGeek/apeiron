import type { CodecName } from '@apeiron/logos';
import { useEffect, useRef, useState, type ReactElement } from 'react';

export type DevMenuProps = {
  codec: CodecName;
  disabled?: boolean;
  onCodecChange: (codec: CodecName) => void;
};

const CODECS: { value: CodecName; label: string }[] = [
  { value: 'json', label: 'JSON' },
  { value: 'msgpack', label: 'MessagePack' },
];

/** Small developer menu: the wire codec toggle (switching re-sends hello). */
export function DevMenu({ codec, disabled, onCodecChange }: DevMenuProps): ReactElement {
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
        </div>
      )}
    </div>
  );
}
