import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { createElement } from "react";
import { mount } from "../helpers/render";
import { registerDom } from "../helpers/dom";
import Providers from "../../src/features/providers/ProvidersPage";
import { queryKeys } from "../../src/data/query-keys";
import type { ProviderResponse } from "../../src/data/contracts";

// Bun evaluates imports before any hook, and `beforeEach` touches
// `localStorage`, so the DOM has to be installed at module scope.
registerDom();


const HIDE_KEY = "cartethyia.hide-unconfigured-providers";

function provider(
  providerId: string,
  overrides: Partial<ProviderResponse> = {},
): ProviderResponse {
  return {
    providerId,
    serviceKinds: ["llm"],
    displayName: providerId,
    enabled: true,
    isBuiltIn: true,
    configured: false,
    requiresAccount: true,
    hasAdapterUserAgent: false,
    supportsWebSearch: false,
    supportsModelDiscovery: true,
    routeIdentityVersions: { codex: "1", claude: "1" },
    ...overrides,
  };
}

/**
 * One configured provider, one unconfigured, one credential-less. The third is
 * the one that catches a naive filter: it has no account because it needs none,
 * so `configured === false` is correct for it and it must stay visible.
 */
const CATALOG: readonly ProviderResponse[] = [
  provider("anthropic", { configured: true, displayName: "Anthropic" }),
  provider("openai", { configured: false, displayName: "OpenAI" }),
  provider("opencode", { configured: false, requiresAccount: false, displayName: "OpenCode Free" }),
];

const seed = [{ key: queryKeys.providers.all, data: CATALOG }];

test("custom provider cards show their configured Base URL", async () => {
  const customProvider = provider("my-gateway", {
    isBuiltIn: false,
    baseUrl: "https://gateway.example/v1",
    configured: true,
  });
  const view = await mount(createElement(Providers), {
    seed: [{ key: queryKeys.providers.all, data: [customProvider] }],
  });
  await view.flush();

  expect(view.container.textContent).toContain("Base URL");
  expect(view.container.textContent).toContain("https://gateway.example/v1");
  view.unmount();
});

function visibleIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('a[href*="/providers/"]')]
    .map((el) => el.getAttribute("href") ?? "")
    .map((href) => href.split("/providers/")[1]?.split(/[?#]/)[0] ?? "")
    .filter(Boolean);
}

function toggleLabel(container: HTMLElement): string {
  const button = [...container.querySelectorAll("button")].find((b) =>
    /unconfigured/i.test(b.textContent ?? ""),
  );
  return button?.textContent?.trim() ?? "";
}

async function clickToggle(container: HTMLElement): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((b) =>
    /unconfigured/i.test(b.textContent ?? ""),
  );
  if (!button) throw new Error("hide-unconfigured toggle not rendered");
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ProvidersPage — hide providers without an account", () => {
  beforeEach(() => {
    localStorage.removeItem(HIDE_KEY);
  });
  afterEach(() => {
    localStorage.removeItem(HIDE_KEY);
  });

  test("shows every provider while the preference is off", async () => {
    const view = await mount(createElement(Providers), { seed });
    await view.flush();

    const ids = visibleIds(view.container);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("opencode");
    expect(toggleLabel(view.container)).toContain("Hide unconfigured");
    view.unmount();
  });

  test("hides only the unconfigured provider that needs a credential", async () => {
    const view = await mount(createElement(Providers), { seed });
    await view.flush();

    await view.act(() => clickToggle(view.container));
    await view.flush();

    const ids = visibleIds(view.container);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("opencode");
    expect(ids).not.toContain("openai");
    view.unmount();
  });

  test("the toggle is a browser preference, persisted across remounts and shared across tabs", async () => {
    const view = await mount(createElement(Providers), { seed });
    await view.flush();
    await view.act(() => clickToggle(view.container));
    await view.flush();

    expect(localStorage.getItem(HIDE_KEY)).toBe("1");
    view.unmount();

    // A remount is the reload case: the flag is read back out of storage, not
    // carried in component state.
    const reloaded = await mount(createElement(Providers), { seed });
    await reloaded.flush();
    expect(visibleIds(reloaded.container)).not.toContain("openai");
    expect(toggleLabel(reloaded.container)).toContain("Show unconfigured");

    // The cross-tab case: the other tab only hears a `storage` event, so the
    // listener is what makes it converge without a reload of its own.
    const other = await mount(createElement(Providers), { seed });
    await other.flush();
    window.dispatchEvent(new Event("storage"));
    await other.flush();
    expect(visibleIds(other.container)).not.toContain("openai");

    other.unmount();
    reloaded.unmount();
  });

  test("turning it back off restores the full list", async () => {
    localStorage.setItem(HIDE_KEY, "1");
    const view = await mount(createElement(Providers), { seed });
    await view.flush();
    expect(visibleIds(view.container)).not.toContain("openai");

    await view.act(() => clickToggle(view.container));
    await view.flush();

    expect(localStorage.getItem(HIDE_KEY)).toBe("0");
    expect(visibleIds(view.container)).toContain("openai");
    view.unmount();
  });
});
