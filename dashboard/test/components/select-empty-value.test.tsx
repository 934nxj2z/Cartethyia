/**
 * The shared `Select` primitive against Radix's reserved empty string.
 *
 * Radix treats `""` as "nothing selected": `Select.Value` falls back to its
 * placeholder for it, the same as for `undefined`. Two consequences, both seen
 * on the "Add Custom OpenAI Provider" API-format dropdown, which showed
 * "Select…" and would not keep `Responses`:
 *
 * - a controlled `""` paints the placeholder even though the caller's state
 *   names a real selection;
 * - an `onValueChange("")` from Radix stores that same dead value, after which
 *   the field reads as reset whatever was picked.
 *
 * Guarded at the primitive so every caller inherits it. Asserted on the two
 * translations rather than on rendered markup, because `Select.Value` paints the
 * placeholder for `""` and for `undefined` alike — a markup assertion passes
 * with or without the guard, which is exactly the trap a test must not fall
 * into.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import {
  Select,
  isSelectableValue,
  radixRootValue,
} from "../../src/components/ui/select";
import { renderMarkup } from "../helpers/render";

const OPTIONS = [
  { value: "chat", label: "Chat completions" },
  { value: "responses", label: "Responses" },
];

function triggerMarkup(value: string): string {
  return renderMarkup(
    createElement(Select, {
      id: "compat-wire",
      label: "API format",
      value,
      onValueChange: () => undefined,
      options: OPTIONS,
    }),
  );
}

describe("radixRootValue", () => {
  test("translates the reserved empty string away", () => {
    // Handing Radix "" makes it render the placeholder for a real selection.
    expect(radixRootValue("")).toBeUndefined();
  });

  test("passes every real value through untouched", () => {
    // Not a blanket `undefined`: a chosen wire must stay a controlled value.
    expect(radixRootValue("chat")).toBe("chat");
    expect(radixRootValue("responses")).toBe("responses");
  });
});

describe("isSelectableValue", () => {
  test("refuses an empty emission", () => {
    // Storing "" is what makes the field read as reset after a pick.
    expect(isSelectableValue("")).toBe(false);
  });

  test("accepts real options", () => {
    expect(isSelectableValue("chat")).toBe(true);
    expect(isSelectableValue("responses")).toBe(true);
  });
});

describe("Select rendering", () => {
  test("a real selection renders its label, not the placeholder", () => {
    const html = triggerMarkup("responses");
    expect(html).toContain("Responses");
    expect(html).not.toContain("Select…");
  });

  test("an unset value still shows the placeholder", () => {
    // Guarding "" must not turn an honest empty field into a fake selection.
    expect(triggerMarkup("")).toContain("Select…");
  });
});

describe("a published empty-value option", () => {
  // The routing card's Client identity offers { value: "", label: "None" }.
  // Refusing it made picking None do nothing: the handler returned before
  // calling onValueChange, so the stored identity never changed.
  const NONE_OPTIONS = [
    { value: "", label: "None" },
    { value: "Cartethyia/1.0.0", label: "Cartethyia 1.0.0" },
  ];

  test("is a real selection the caller receives", () => {
    expect(isSelectableValue("", NONE_OPTIONS)).toBe(true);
  });


  test("a value no option carries is still refused", () => {
    // The API-format dropdown: no `""` option, so an empty emission is Radix's
    // placeholder convention and must not be stored.
    expect(isSelectableValue("", OPTIONS)).toBe(false);
  });
});
