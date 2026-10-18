/**
 * Add Proxy batch form: scheme chips and the shared-family quota split.
 *
 * Both are the parts of that dialog most likely to regress silently, because
 * neither is visible until a batch is submitted:
 *
 * 1. **A chip must prefix, never mangle.** The failure that motivated the chips
 *    was an `https://` host pasted without its scheme being read as `http`. The
 *    mirror failure — a chip turning that same host into `http://https://host`
 *    — is just as bad and just as invisible, so the explicit-scheme guard is
 *    pinned as directly as the prefixing itself.
 * 2. **A shared quota must stay shared.** The operator types one figure for a
 *    family; if each row stored it wholesale the family's allowance would be
 *    multiplied by its own size. The split is also lossy by nature (100 GB over
 *    3 members), so the remainder rule that keeps the sum exact is asserted
 *    rather than assumed.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderMarkup } from "../helpers/render";
import { SchemeChipRow } from "../../src/features/proxy/ProxyPage";
import {
  SCHEME_CHIPS,
  applySchemeChip,
  chipTargetLine,
  detectProxyKind,
  hasExplicitScheme,
  parseQuotaGb,
  splitQuotaAcrossFamily,
} from "../../src/features/proxy/proxy-endpoint";

const GIB = 1024 ** 3;
describe("scheme chips", () => {
  test("prefixes a bare host with the chosen scheme", () => {
    expect(applySchemeChip("proxy.example:8080", "https")).toBe("https://proxy.example:8080");
    expect(applySchemeChip("proxy.example:8080", "http")).toBe("http://proxy.example:8080");
    expect(applySchemeChip("proxy.example:1080", "socks5")).toBe("socks5://proxy.example:1080");
  });

  test("a chip only ever applies to a bare host", () => {
    expect(applySchemeChip("https://proxy.example:8443", "http")).toBe("https://proxy.example:8443");
    expect(applySchemeChip("socks5://proxy.example:1080", "http")).toBe("socks5://proxy.example:1080");
  });

  test("a scheme with credentials and a path is still recognized as explicit", () => {
    // A real paste carries `user:pass@host:port`; the chip must not treat the
    // `@`/`/` as a scheme and mangle it.
    const line = "https://user:pass@proxy.example:8443/path";
    expect(hasExplicitScheme(line)).toBe(true);
    expect(applySchemeChip(line, "http")).toBe(line);
  });

  test("a bare host carries no explicit scheme", () => {
    expect(hasExplicitScheme("proxy.example:8080")).toBe(false);
    expect(hasExplicitScheme("user:pass@proxy.example:8080")).toBe(false);
  });

  test("no chip selected leaves the line untouched", () => {
    expect(applySchemeChip("proxy.example:8080", null)).toBe("proxy.example:8080");
  });

  test("the chips cover every transport the pool accepts", () => {
    expect(SCHEME_CHIPS).toEqual(["http", "https", "socks5"]);
  });

  test("the chip target is the first non-empty line, ignoring blank lines", () => {
    expect(chipTargetLine(["", "  ", "first.example:1", "second.example:2"])).toBe("first.example:1");
    expect(chipTargetLine([])).toBeUndefined();
    expect(chipTargetLine(["", "   "])).toBeUndefined();
  });

  test("detectProxyKind reads an explicit scheme and defaults bare to http", () => {
    expect(detectProxyKind("https://proxy.example:8443")).toBe("https");
    expect(detectProxyKind("socks5://proxy.example:1080")).toBe("socks5");
    expect(detectProxyKind("socks://proxy.example:1080")).toBe("socks5");
    // The chip's whole purpose: a bare host is http until a chip says otherwise.
    expect(detectProxyKind("proxy.example:8080")).toBe("http");
  });

  test("a chipped line is read with the scheme the chip chose", () => {
    // End to end across the two helpers: chip first, then detect.
    expect(detectProxyKind(applySchemeChip("proxy.example:8443", "https"))).toBe("https");
  });
});

describe("the shared-family quota split", () => {
  test("divides one quota evenly across the family's endpoints", () => {
    // 100 GB over 5 endpoints: the operator's figure is the family's allowance,
    // so each endpoint gets a fifth of it, not the whole thing.
    const perRow = splitQuotaAcrossFamily(100 * GIB, "residential", 5);
    expect(perRow.size).toBe(5);
    for (const quota of perRow.values()) {
      expect(quota).toBe(20 * GIB);
    }
  });

  test("the family's rows still sum to exactly the entered figure", () => {
    // floor(100/3) loses a byte per member; the last member absorbs the remainder
    // so 100 GB never silently becomes 99 GB.
    const quotaBytes = 100 * GIB;
    const perRow = splitQuotaAcrossFamily(quotaBytes, "residential", 3);
    let total = 0;
    for (const quota of perRow.values()) total += quota;
    expect(total).toBe(quotaBytes);
    const shares = [...perRow.values()];
    expect(shares[0]).toBe(Math.floor(quotaBytes / 3));
    expect(shares[2]).toBe(quotaBytes - 2 * Math.floor(quotaBytes / 3));
  });

  test("a single endpoint takes the whole quota", () => {
    const perRow = splitQuotaAcrossFamily(10 * GIB, "residential", 1);
    expect(perRow.get(0)).toBe(10 * GIB);
  });

  test("rows with no family are outside any pool and take no quota", () => {
    expect(splitQuotaAcrossFamily(100 * GIB, "", 5).size).toBe(0);
    expect(splitQuotaAcrossFamily(100 * GIB, "   ", 5).size).toBe(0);
  });

  test("family matching is case-insensitive so a pool is not split in two", () => {
    // "Residential" and "residential" must land in one pool; a case-sensitive
    // key would create two pools that each claim the same allowance.
    const perRow = splitQuotaAcrossFamily(100 * GIB, " Residential ", 5);
    expect(perRow.size).toBe(5);
  });

  test("a non-positive line count yields no allocations", () => {
    expect(splitQuotaAcrossFamily(100 * GIB, "residential", 0).size).toBe(0);
  });
});

describe("quota field parsing", () => {
  test("converts GB to bytes and treats blank as unmetered", () => {
    expect(parseQuotaGb("100")).toBe(100 * GIB);
    expect(parseQuotaGb("")).toBeNull();
    expect(parseQuotaGb("   ")).toBeNull();
    expect(parseQuotaGb("abc")).toBeNull();
    expect(parseQuotaGb("0")).toBeNull();
    expect(parseQuotaGb("-5")).toBeNull();
  });
});

/**
 * The chips rendered, not just the helpers behind them.
 *
 * The row is rendered directly with props because driving a textarea's value
 * through happy-dom does not fire React's synthetic `onChange` — so the
 * operator-visible behaviour (which chips exist, which is pressed, what preview
 * appears) is asserted against the extracted component with explicit props.
 */
describe("SchemeChipRow (rendered)", () => {
  test("renders all three schemes and previews the chosen one", () => {
    const html = renderMarkup(
      createElement(SchemeChipRow, {
        endpoint: "proxy.example:8443",
        chip: null,
        onChipChange: () => {},
      }),
    );
    for (const scheme of ["http://", "https://", "socks5://"]) {
      expect(html).toContain(scheme);
    }
    // Nothing is pressed yet, so no preview line.
    expect(html).not.toContain("→");
  });

  test("the pressed chip previews the endpoint it will produce", () => {
    const html = renderMarkup(
      createElement(SchemeChipRow, {
        endpoint: "proxy.example:8443",
        chip: "https",
        onChipChange: () => {},
      }),
    );
    expect(html).toContain("https://proxy.example:8443");
    expect(html).toContain('data-scheme="https"');
  });

  test("the chips are disabled until the paste has an endpoint", () => {
    const html = renderMarkup(
      createElement(SchemeChipRow, { endpoint: undefined, chip: null, onChipChange: () => {} }),
    );
    for (const scheme of SCHEME_CHIPS) {
      const chip = html.match(new RegExp(`<button[^>]*data-scheme="${scheme}"[^>]*>`));
      expect(chip).not.toBeNull();
      expect(chip![0]).toContain("disabled");
    }
  });
});
