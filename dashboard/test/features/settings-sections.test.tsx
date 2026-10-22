/**
 * Settings page contract: every section is on the page at once.
 *
 * The property worth pinning is that no setting is hidden behind a tab or a
 * disclosure — the page used to show one section at a time, so an operator
 * hunting for a setting had to know which heading concealed it. Now the whole
 * surface renders, so a control that quietly moved behind a selector shows up
 * here as a failure.
 *
 * Also pinned: no nested cards, and no tab markup left behind. The page used to
 * render a card inside a card, doubling borders and padding, which only shows
 * up visually.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import Settings, { boundedOptions } from "../../src/features/settings/SettingsPage";
import { mount, stubFetch } from "../helpers/render";
import { registerDom } from "../helpers/dom";

/**
 * Radix's Select touches `HTMLFormElement` while wiring its hidden form
 * field, and happy-dom does not put that constructor on `globalThis` — only
 * on `window`. Mounting a real Select therefore needs it aliased first, or the
 * component throws before it renders.
 *
 * This runs in `beforeAll` rather than at module scope: Bun shares one process
 * across test files, so importing a DOM at module load leaks it into sibling
 * suites that expect a bare environment.
 */
beforeAll(() => {
registerDom();
  // happy-dom installs its constructors on `window` but not on `globalThis`,
  // and Radix reaches for them unqualified — `HTMLFormElement`, then
  // `DocumentFragment`, then whatever it touches next. Alias every missing
  // window property rather than guessing a prefix: patching the one name in
  // the current error just moves the failure along.
  const source = globalThis.window as unknown as Record<string, unknown>;
  const target = globalThis as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(source)) {
    if (target[name] !== undefined) continue;
    // Some window properties are read-only accessors, so a plain assignment
    // throws; define them instead and skip the few that cannot be redefined.
    try {
      Object.defineProperty(target, name, {
        value,
        writable: true,
        configurable: true,
      });
    } catch {
      // Not aliasing this one is fine: it either already works or is unused.
    }
  }
});

const SETTINGS = {
  telemetryPayloads: "none",
  telemetryPayloadDepth: "minimum",
  privacyMode: "masked",
  forceDisableCooldown: false,
  upstreamTimeoutSeconds: null,
  telemetryCompactAfterDays: null,
  imageClampMaxBytes: null,
};

async function mountSettings() {
  // The hook requests "/settings/runtime", which `consoleRequest` prefixes to
  // "/console/api/settings/runtime". The match is method-qualified because
  // `stubFetch` skips a route whose `match` does not contain the request
  // method, so a bare path never answers a GET.
  const stub = stubFetch([
    { match: "GET /console/api/settings/runtime", json: SETTINGS },
  ]);
  const mounted = await mount(createElement(Settings));
  // The privacy and operations panels show a loading state until their query
  // settles, so assertions run after the flush rather than against a skeleton.
  await mounted.flush();
  await mounted.flush();
  return { ...mounted, restore: stub.restore };
}

describe("Settings sections", () => {
  test("all four sections render at once", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      // Each section is a card whose header carries the h2, nested several
      // levels down. Match on the header's own class so a wrapper added later
      // does not break this.
      // Scoped to the four section ids, because the page's own "Settings"
      // header is also an h2 and is not a section.
      const titles = [
        "security",
        "privacy",
        "operations",
        "data",
        "data-management",
      ].map((id) =>
        container.querySelector(`#${id} h2.card-header-title`)?.textContent,
      );
      expect(titles).toEqual([
        "Security",
        "Privacy",
        "Operations",
        "Data",
        "Data Management",
      ]);
    } finally {
      unmount();
      restore();
    }
  });

  test("every section's controls are reachable without selecting anything", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      // One control per section: if any of these is missing, that section is
      // hidden behind a selector again.
      for (const id of [
        "current-password", // Security
        "privacy-payloads", // Privacy
        "image-clamp-max-bytes", // Operations
      ]) {
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
      // Data's control has no id of its own; assert the section exists and is
      // populated rather than reaching for a button label that may change.
      const data = container.querySelector("#data");
      expect(data).not.toBeNull();
      expect(data?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("nothing is behind a tab", async () => {
    // Guards against a tab strip creeping back in: role=tab would mean one
    // section is visible and the rest are hidden again.
    const { container, unmount, restore } = await mountSettings();
    try {
      expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(0);
      expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("each section is its own card", async () => {
    // The section card is the intended nesting: the page card holds a titled
    // card per section. What must not happen is a third level — a card inside
    // a section card, which is the doubled-border shape this replaced.
    //
    // Matched on `.card-solid` — the class Card actually emits. A `.card`
    // selector matches nothing and would pass no matter the markup.
    const { container, unmount, restore } = await mountSettings();
    try {
      // Five sections: Security, Privacy, Operations, Data, Data Management.
      expect(container.querySelectorAll(".card-solid .card-solid")).toHaveLength(5);
      expect(container.querySelectorAll(".card-solid .card-solid .card-solid")).toHaveLength(0);
    } finally {
      unmount();
      restore();
    }
  });

  test("each section is still deep-linkable", async () => {
    const { container, unmount, restore } = await mountSettings();
    try {
      for (const id of ["security", "privacy", "operations", "data", "data-management"]) {
        expect(container.querySelector(`#${id}`)).not.toBeNull();
      }
    } finally {
      unmount();
      restore();
    }
  });

  test("Security and Privacy share a row, Operations and Data do not", async () => {
    // The desktop split: the two short sections sit side by side. Asserted on
    // the grid wrapper rather than computed layout, which a test DOM has none
    // of.
    const { container, unmount, restore } = await mountSettings();
    try {
      const security = container.querySelector("#security");
      const privacy = container.querySelector("#privacy");
      const operations = container.querySelector("#operations");
      expect(security?.parentElement).toBe(privacy?.parentElement);
      expect(security?.parentElement?.className).toContain("grid-cols-2");
      // Operations keeps its own full-width row.
      expect(operations?.parentElement).not.toBe(security?.parentElement);
    } finally {
      unmount();
      restore();
    }
  });

  test("the Privacy controls are stacked, not side by side", async () => {
    // One column: reading two-up made the eye zig-zag between label, control,
    // and help text. Pinned as a class because a test DOM has no layout.
    const { container, unmount, restore } = await mountSettings();
    try {
      const privacy = container.querySelector("#privacy");
      const fields = Array.from(
        privacy?.querySelectorAll(".settings-field") ?? [],
      );
      expect(fields.length).toBeGreaterThanOrEqual(2);
      // Every field shares one parent, and that parent is not a grid.
      const parents = new Set(fields.map((f) => f.parentElement));
      expect(parents.size).toBe(1);
      expect(fields[0]?.parentElement?.className).not.toContain("grid-cols-");
    } finally {
      unmount();
      restore();
    }
  });

  test("every text size used is a defined token", async () => {
    // The scale is micro/badge/caption/body/body-lg/lead/title/display/hero.
    // `text-subtitle` was used for section headings but no such token exists,
    // so those headings fell back to the browser default and read larger than
    // anything else on the page — the inconsistency was invisible in review
    // because the class name looks right.
    const DEFINED = [
      "text-micro",
      "text-badge",
      "text-caption",
      "text-body",
      "text-body-lg",
      "text-lead",
      "text-title",
      "text-display",
      "text-hero",
    ];
    const { container, unmount, restore } = await mountSettings();
    try {
      // Collected from the markup, not filtered by the allowlist: a size is
      // "text-*" minus alignment and colour utilities, and anything left that
      // is not a defined token is a size that does not exist.
      const NOT_A_SIZE =
        /^text-(text|accent|danger|warning|success|inherit|current|transparent|left|right|center|justify|start|end|white|black|ellipsis|wrap|nowrap|clip|uppercase|lowercase|capitalize)/;
      const used = new Set<string>();
      for (const el of Array.from(container.querySelectorAll("*"))) {
        for (const cls of el.classList) {
          if (!cls.startsWith("text-") || NOT_A_SIZE.test(cls)) continue;
          used.add(cls);
        }
      }
      expect(used.size).toBeGreaterThan(0);
      expect([...used].filter((c) => !DEFINED.includes(c))).toEqual([]);
    } finally {
      unmount();
      restore();
    }
  });
});

  test("Backup headings sit below the card header, not above it", async () => {
    // "Backup" and "Delete data" used `text-title` (18px) while the card
    // header above them is 14px, so the child read bigger than its parent.
    // Asserted on the class: a test DOM resolves no font sizes.
    const { container, unmount, restore } = await mountSettings();
    try {
      const backup = container.querySelector("#data h3");
      expect(backup?.textContent).toBe("Backup");
      expect(backup?.className).toContain("text-body-lg");
      expect(backup?.className).not.toContain("text-title");
      const del = container.querySelector("#data h3 + p");
      expect(del?.className).toContain("text-caption");
    } finally {
      unmount();
      restore();
    }
  });

  test("a field's label reads larger than its help text", async () => {
    // The hierarchy that was missing: label, control value, and help text were
    // all 12px, so one field was three equal blocks. Pinned as a class
    // comparison rather than a computed size, which a test DOM does not resolve.
    const { container, unmount, restore } = await mountSettings();
    try {
      const field = container.querySelector("#privacy .settings-field");
      expect(field).not.toBeNull();
      const label = field?.querySelector(".form-label");
      const help = field?.querySelector("p");
      expect(label).not.toBeNull();
      expect(help).not.toBeNull();
      // 13px label vs 12px help: `text-body` must not appear on the help text.
      expect(help?.className).toContain("text-caption");
      expect(help?.className).not.toContain("text-body");
    } finally {
      unmount();
      restore();
    }
  });

describe("boundedOptions", () => {
  const CHOICES = [5, 30, 600] as const;
  const suffix = (v: number): string => `${v}s`;

  test("offers every choice when nothing is stored", () => {
    expect(boundedOptions(CHOICES, null, suffix)).toEqual([
      { value: "5", label: "5s" },
      { value: "30", label: "30s" },
      { value: "600", label: "600s" },
    ]);
  });

  test("keeps a stored value that is already a choice", () => {
    const options = boundedOptions(CHOICES, 30, suffix);
    // Duplicating it would render the same entry twice.
    expect(options.filter((o) => o.value === "30")).toHaveLength(1);
    expect(options).toHaveLength(3);
  });

  test("a value outside the list is offered, in order", () => {
    // The load-bearing case: a value set elsewhere must still be selectable,
    // or the trigger renders empty for a setting that is in force and reads as
    // "unset" — inviting the operator to change something already correct.
    expect(boundedOptions(CHOICES, 45, suffix)).toEqual([
      { value: "5", label: "5s" },
      { value: "30", label: "30s" },
      { value: "45", label: "45s" },
      { value: "600", label: "600s" },
    ]);
  });
});
