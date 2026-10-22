/**
 * Contract tests for the toggle.
 *
 * The property worth pinning is that one click flips the state once. The
 * control used to nest its button inside a `<label htmlFor>` pointing at that
 * same button, so a click activated it twice — and because both activations
 * read the same `checked` prop, it flipped twice and appeared not to move at
 * all. That is invisible in review and only shows up when someone clicks it,
 * which is exactly why it needs a test.
 */
import { describe, expect, test } from "bun:test";
import { createElement, useState } from "react";
import { Switch } from "../../src/components/ui/switch";
import { mount } from "../helpers/render";

describe("Switch", () => {
  test("one click on the track asks to flip exactly once", async () => {
    const seen: boolean[] = [];
    const { container, act, unmount } = await mount(
      createElement(Switch, { checked: false, onChange: (next) => seen.push(next) }),
    );
    try {
      const track = container.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(track).not.toBeNull();
      await act(() => {
        track?.click();
      });
      // Twice would mean the label forwarded the click and the button also
      // received it: two flips from one gesture, landing back where it began.
      expect(seen).toEqual([true]);
    } finally {
      unmount();
    }
  });

  test("the toggle is reachable through the row, not a label", async () => {
    const seen: boolean[] = [];
    const { container, act, unmount } = await mount(
      createElement(Switch, {
        checked: true,
        onChange: (next) => seen.push(next),
        label: "Enabled",
      }),
    );
    try {
      // No `<label htmlFor>` may point at the button: that was the double-activation
      // path. The row is a plain container, and the button is the only target.
      expect(container.querySelectorAll("label")).toHaveLength(0);
      const wrapper = container.querySelector<HTMLElement>(".switch-container");
      expect(wrapper?.getAttribute("for")).toBeNull();
      const track = container.querySelector<HTMLButtonElement>('[role="switch"]');
      await act(() => {
        track?.click();
      });
      expect(seen).toEqual([false]);
    } finally {
      unmount();
    }
  });

  test("a stateful host actually changes state on one click", async () => {
    // End-to-end proof rather than counting calls: the reported symptom was
    // "clicking does nothing", which is a state assertion, not a call count.
    function Host(): React.ReactNode {
      const [on, setOn] = useState(false);
      return createElement("div", null, [
        createElement(Switch, { key: "s", checked: on, onChange: setOn }),
        createElement("span", { key: "v" }, on ? "on" : "off"),
      ]);
    }
    const { container, act, unmount } = await mount(createElement(Host));
    try {
      expect(container.textContent).toContain("off");
      const track = container.querySelector<HTMLButtonElement>('[role="switch"]');
      await act(() => {
        track?.click();
      });
      expect(container.textContent).toContain("on");
      expect(track?.getAttribute("aria-checked")).toBe("true");
    } finally {
      unmount();
    }
  });

  test("a disabled toggle fires nothing", async () => {
    const seen: boolean[] = [];
    const { container, act, unmount } = await mount(
      createElement(Switch, {
        checked: false,
        onChange: (next) => seen.push(next),
        disabled: true,
      }),
    );
    try {
      const track = container.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(track?.disabled).toBe(true);
      await act(() => {
        track?.click();
      });
      expect(seen).toEqual([]);
    } finally {
      unmount();
    }
  });
});
