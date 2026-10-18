import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { cn } from "../lib/classnames";
import { gapUtility } from "../lib/spacing";

/**
 * A vertical list whose rows the operator can drag into a new order.
 *
 * Each row gets a left rail carrying a drag handle and its 1-based position.
 * The position is presentation only — it is derived from array order and is
 * never sent to the client as data — but showing it makes the order explicit
 * and gives the operator something to point at while dragging.
 *
 * `onReorder` receives the complete new id order; callers persist it wholesale
 * so the server never has to infer an intent from a partial list.
 */
export function SortableList<T extends { id: string }>({
  items,
  onReorder,
  disabled = false,
  gap = "10px",
  renderItem,
  label,
}: {
  items: readonly T[];
  onReorder: (ids: string[]) => void;
  disabled?: boolean;
  gap?: string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Accessible name for the list, e.g. "API credentials". */
  label?: string;
}): ReactNode {
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // The dragged row's id is needed synchronously in `drop`, where React state
  // may not have committed yet.
  const dragIdRef = useRef<string | null>(null);

  const endDrag = () => {
    dragIdRef.current = null;
    setDragId(null);
    setOverId(null);
  };

  const move = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = items.map((item) => item.id);
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    onReorder(ids);
  };

  return (
    <div
      role="list"
      aria-label={label}
      className={cn("flex flex-col min-w-0", gapUtility(gap) ?? "gap-5")}
    >
      {items.map((item, index) => {
        const dragging = dragId === item.id;
        const isOver = overId === item.id && dragId !== null && dragId !== item.id;
        const moveBy = (offset: -1 | 1) => {
          const targetIndex = index + offset;
          if (disabled || targetIndex < 0 || targetIndex >= items.length) return;
          const ids = items.map((entry) => entry.id);
          const [movedId] = ids.splice(index, 1);
          if (movedId === undefined) return;
          ids.splice(targetIndex, 0, movedId);
          onReorder(ids);
        };
        return (
          <div
            key={item.id}
            role="listitem"
            className={cn(
              "relative flex items-stretch gap-5 min-w-0 rounded-card transition-opacity duration-150 ease-spring",
              dragging && "opacity-50",
              isOver && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent before:content-['']",
            )}
            data-dragging={dragging ? "true" : undefined}
            data-drop-target={isOver ? "true" : undefined}
            onDragOver={(event: DragEvent<HTMLDivElement>) => {
              if (disabled || dragIdRef.current === null) return;
              // Required for `drop` to fire on this element.
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (overId !== item.id) setOverId(item.id);
            }}
            onDrop={(event: DragEvent<HTMLDivElement>) => {
              event.preventDefault();
              const fromId = dragIdRef.current;
              if (fromId !== null) move(fromId, item.id);
              endDrag();
            }}
          >
            <div className="flex flex-none flex-col items-center gap-1 pt-4 text-text-tertiary select-none">
              <div className="flex items-center gap-1">
                <span className="font-mono text-badge tabular-nums leading-none">{index + 1}</span>
                <button
                  type="button"
                  draggable={!disabled}
                  aria-label={`Drag item at position ${index + 1} to reorder`}
                  title="Drag to reorder"
                  disabled={disabled}
                  onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                    dragIdRef.current = item.id;
                    setDragId(item.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.id);
                  }}
                  onDragEnd={endDrag}
                  className="grid size-7 cursor-grab place-items-center rounded-control text-text-tertiary hover:bg-hover active:cursor-grabbing disabled:cursor-not-allowed"
                >
                  <GripVertical size={14} />
                </button>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  aria-label={`Move item ${index + 1} up`}
                  title="Move up"
                  disabled={disabled || index === 0}
                  onClick={() => moveBy(-1)}
                  className="grid size-7 place-items-center rounded-control text-text-tertiary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  aria-label={`Move item ${index + 1} down`}
                  title="Move down"
                  disabled={disabled || index === items.length - 1}
                  onClick={() => moveBy(1)}
                  className="grid size-7 place-items-center rounded-control text-text-tertiary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>
            <div className="flex-auto min-w-0">{renderItem(item, index)}</div>
          </div>
        );
      })}
    </div>
  );
}
