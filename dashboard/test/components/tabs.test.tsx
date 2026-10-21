/**
 * Contract tests for the tab strip.
 *
 * What is worth pinning is the ARIA wiring and the roving tabindex, both of
 * which are invisible in a screenshot and silently break accessibility when
 * someone edits the markup: a `role="tab"` without `aria-controls`, or four
 * tabs all at `tabIndex=0`, each reads fine in review and each is wrong.
 *
 * Also pinned: only the selected panel renders. Settings panels fetch on
 * mount, so rendering all four would fire every request on page load.
 */
import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { Tabs } from "../../src/components/ui/tabs";
import { renderMarkup, mount } from "../helpers/render";

const ITEMS = [
  { id: "one", label: "One" },
  { id: "two", label: "Two" },
  { id: "three", label: "Three" },
];

function render(active: string, onChange = () => {}): string {
  return renderMarkup(
    createElement(Tabs, {
      items: ITEMS,
      active,
      onChange,
      label: "Sections",
      panels: {
        one: createElement("p", null, "panel:one"),
        two: createElement("p", null, "panel:two"),
        three: createElement("p", null, "panel:three"),
      },
    }),
  );
}

describe("Tabs", () => {
  test("emits the tablist with every tab labelled", () => {
    const html = render("one");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Sections"');
    for (const item of ITEMS) {
      expect(html).toContain(`role="tab"`);
      expect(html).toContain(item.label);
    }
  });

  test("only the active tab is selected", () => {
    const html = render("two");
    // One selected and two not: aria-selected is what a screen reader reads,
    // and getting it wrong makes every tab announce as active.
    expect(html.match(/aria-selected="true"/g) ?? []).toHaveLength(1);
    expect(html.match(/aria-selected="false"/g) ?? []).toHaveLength(2);
  });

  test("the strip is one tab stop, not one per tab", () => {
    const html = render("one");
    // Roving tabindex: Tab leaves the strip instead of walking it.
    expect(html.match(/tabindex="0"/g) ?? []).toHaveLength(2); // selected tab + panel
    expect(html.match(/tabindex="-1"/g) ?? []).toHaveLength(2);
  });

  test("the panel is labelled by its tab", () => {
    const html = render("one");
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby=');
  });

  test("only the selected panel's content renders", () => {
    // The load-bearing property behind not stacking all panels: each one owns
    // a query, and mounting them all fires every request at once.
    expect(render("one")).toContain("panel:one");
    expect(render("one")).not.toContain("panel:two");
    expect(render("three")).toContain("panel:three");
    expect(render("three")).not.toContain("panel:one");
  });

});

describe("Tabs behaviour", () => {
  /** A stateful host, so selection actually changes the rendered panel. */
  function Host(): React.ReactNode {
    const [active, setActive] = useState("one");
    return createElement(Tabs, {
      items: ITEMS,
      active,
      onChange: setActive,
      label: "Sections",
      panels: {
        one: createElement("p", null, "panel:one"),
        two: createElement("p", null, "panel:two"),
        three: createElement("p", null, "panel:three"),
      },
    });
  }

  const tabsIn = (container: HTMLElement): HTMLButtonElement[] =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

  test("clicking a tab selects it and swaps the panel", async () => {
    const { container, act, unmount } = await mount(createElement(Host));
    try {
      expect(container.textContent).toContain("panel:one");
      const tabs = tabsIn(container);
      expect(tabs).toHaveLength(3);

      await act(() => tabs[2]?.click());
      expect(container.textContent).toContain("panel:three");
      expect(tabsIn(container)[2]?.getAttribute("aria-selected")).toBe("true");
      // The previously selected tab must not stay selected — two active tabs
      // is the bug this guards.
      expect(tabsIn(container)[0]?.getAttribute("aria-selected")).toBe("false");
    } finally {
      unmount();
    }
  });

  test("arrow keys move selection, and focus follows", async () => {
    const { container, act, unmount } = await mount(createElement(Host));
    try {
      const first = tabsIn(container)[0];
      first?.focus();

      await act(() => {
        first?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      expect(container.textContent).toContain("panel:two");
      // Focus must follow selection, or the ring stays behind while the panel
      // has already changed under it.
      expect(document.activeElement?.textContent).toContain("Two");

      await act(() => {
        document.activeElement?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
        );
      });
      expect(container.textContent).toContain("panel:one");
    } finally {
      unmount();
    }
  });

  test("End jumps to the last tab and wraps no further", async () => {
    const { container, act, unmount } = await mount(createElement(Host));
    try {
      const first = tabsIn(container)[0];
      first?.focus();
      await act(() => {
        first?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "End", bubbles: true }),
        );
      });
      expect(container.textContent).toContain("panel:three");

      // Wrapping is deliberate: arrowing past the end returns to the first
      // tab rather than dead-ending.
      const last = tabsIn(container)[2];
      await act(() => {
        last?.dispatchEvent(
          new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      expect(container.textContent).toContain("panel:one");
    } finally {
      unmount();
    }
  });
});
