import { useId, useRef, type ReactNode } from "react";
import { cn } from "../../lib/classnames";

/**
 * Horizontal tab strip with its panel, following the ARIA tabs pattern.
 *
 * The keyboard contract is the part that is easy to get wrong and invisible
 * until someone uses it: arrow keys move between tabs, Home/End jump to the
 * ends, and focus follows selection (so the tab strip stays where the user's
 * hands are). Roving tabindex keeps the strip one stop in the page's tab order
 * rather than four — a tab list that traps Tab is worse than no tabs at all.
 *
 * Only the selected panel is rendered. Settings panels own their own queries
 * and mutations, so mounting all four would fire every request on page load
 * and keep four sets of form state alive for no reason.
 */

export interface TabItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  /** Optional end-aligned hint: a count, a status dot, a short state word. */
  readonly meta?: ReactNode;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly active: string;
  readonly onChange: (id: string) => void;
  /**
   * One panel per tab id. A record rather than `children` because the strip
   * cannot tell which of several children belongs to `active`: with plain
   * children it would have to render all of them, and each settings panel
   * fetches on mount — so every query would fire on page load.
   */
  readonly panels: Readonly<Record<string, ReactNode>>;
  /** Accessible name for the strip, since a page may hold more than one. */
  readonly label: string;
  readonly className?: string;
}

export function Tabs({
  items,
  active,
  onChange,
  panels,
  label,
  className = "",
}: TabsProps): ReactNode {
  const baseId = useId();
  const stripRef = useRef<HTMLDivElement>(null);
  // A ref per tab rather than `querySelector("#" + id)`: ids from `useId()`
  // contain colons that must be escaped before they are valid in a selector,
  // and `CSS.escape` is a browser global a test DOM does not always provide —
  // when it is missing the handler throws and focus silently never moves.
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const move = (delta: number): void => {
    const index = items.findIndex((item) => item.id === active);
    if (index < 0) return;
    const next = items[(index + delta + items.length) % items.length];
    if (next === undefined) return;
    onChange(next.id);
    // Focus follows selection: after an arrow key the strip is still the
    // user's context, and without this the focus ring would stay on the
    // previous tab while the panel had already changed under it.
    tabRefs.current.get(next.id)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = items[0];
      if (first !== undefined) onChange(first.id);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = items[items.length - 1];
      if (last !== undefined) onChange(last.id);
    }
  };

  return (
    <div className={cn("flex flex-col min-w-0", className)}>
      <div
        ref={stripRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex items-center gap-1 min-w-0 overflow-x-auto border-b border-inner-border pb-0"
      >
        {items.map((item) => {
          const selected = item.id === active;
          return (
            <button
              key={item.id}
              id={tabId(baseId, item.id)}
              ref={(node) => {
                if (node) tabRefs.current.set(item.id, node);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId(baseId, item.id)}
              // Roving tabindex: the selected tab is the only one in the page
              // order, so Tab leaves the strip instead of walking it.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(item.id)}
              className={cn(
                "flex items-center gap-3 shrink-0 px-5 py-4 text-caption font-semibold border-b-2 -mb-px transition-colors duration-(--dur-micro) ease-standard",
                "focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2",
                selected
                  ? "border-accent text-text-primary"
                  : "border-transparent text-text-secondary hover:text-text-primary hover:border-border-strong",
              )}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.meta !== undefined ? (
                <span className="text-badge text-text-tertiary">
                  {item.meta}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        id={panelId(baseId, active)}
        role="tabpanel"
        aria-labelledby={tabId(baseId, active)}
        tabIndex={0}
        className="pt-6 min-w-0 focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2"
      >
        {panels[active]}
      </div>
    </div>
  );
}

function tabId(base: string, id: string): string {
  return `${base}-tab-${id}`;
}

function panelId(base: string, id: string): string {
  return `${base}-panel-${id}`;
}
