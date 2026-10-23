import type { ReactNode } from "react";
import { cn } from "../../lib/classnames";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  /** Accessible name override. Defaults to the visible `label` when present. */
  ["aria-label"]?: string;
  /** Merged onto the label, so a caller can position the control (e.g. `ml-3`). */
  readonly className?: string;
}

/**
 * A toggle, or a labelled wrapper around one.
 *
 * The button is not wrapped in a `<label htmlFor>` pointing at itself. It used
 * to be, and one click then activated the control twice: the label forwarded
 * the activation to its target and the click reached the button as well. Both
 * calls read the same `checked` prop and both asked to flip it, so it flipped
 * twice and landed back where it started — clicking the toggle did nothing. A
 * label may not wrap an interactive descendant in the first place.
 *
 * The handler sits on the button and the container is a plain `div`, so there
 * is exactly one activation path: a click reaches the button and flips once.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  ["aria-label"]: ariaLabel,
  className = "",
}: SwitchProps): ReactNode {
  return (
    <div
      className={cn(`switch-container ${disabled ? "is-disabled" : ""}`.trim(), className)}
    >
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={disabled ? undefined : () => onChange(!checked)}
        className={`switch-track ${checked ? "is-checked" : ""}`}
      >
        <span className="switch-thumb" />
      </button>
      {label ? <span className="switch-label">{label}</span> : null}
    </div>
  );
}
