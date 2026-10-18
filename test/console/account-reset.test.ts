/**
 * The console-account reset, which is the only password recovery the install
 * has: `/change-password` needs the current password, and first-boot setup only
 * runs when no console user exists. Removing the user is what puts the wizard
 * back, so this route destroys every operator credential and has to be gated.
 *
 * Three gates, each tested separately: loopback peer, constant-time token, and
 * the literal `RESET` body. The token is checked independently of the peer so a
 * leaked token alone cannot reach it from another host.
 */
import { expect, test } from "bun:test";
import { createConsoleAccountResetHandler } from "../../src/console/auth/account-reset";

const TOKEN = "reset-token-under-test";

function handler(options: {
  peer?: string | null;
  resets?: number;
  calls?: { count: number };
}): (context: { request: Request; body: unknown }) => Promise<Response> {
  return createConsoleAccountResetHandler({
    token: TOKEN,
    resolvePeerAddress: () => (options.peer === undefined ? "127.0.0.1" : options.peer),
    resetConsoleAccount: async () => {
      if (options.calls) options.calls.count += 1;
      return options.resets ?? 0;
    },
  });
}

function request(token: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["x-drain-token"] = token;
  return new Request("http://127.0.0.1:12800/admin/reset-console-account", {
    method: "POST",
    headers,
  });
}

test("a non-loopback peer is refused even with the right token", async () => {
  const calls = { count: 0 };
  const respond = handler({ peer: "203.0.113.9", calls });
  expect(respond({ request: request(TOKEN), body: { confirm: "RESET" } })).rejects.toThrow(
    /loopback/,
  );
  expect(calls.count).toBe(0);
});

test("a missing or wrong token is refused", async () => {
  const respond = handler({});
  expect(respond({ request: request(null), body: { confirm: "RESET" } })).rejects.toThrow(
    /invalid reset token/,
  );
  expect(respond({ request: request("wrong"), body: { confirm: "RESET" } })).rejects.toThrow(
    /invalid reset token/,
  );
});

test("the body must carry the literal RESET confirmation", async () => {
  const calls = { count: 0 };
  const respond = handler({ calls });
  for (const body of [{}, { confirm: "reset" }, { confirm: "YES" }, null, "RESET"]) {
    expect(respond({ request: request(TOKEN), body })).rejects.toThrow(/confirm/);
  }
  expect(calls.count).toBe(0);
});

test("a fully confirmed request resets and reports the count", async () => {
  const calls = { count: 0 };
  const respond = handler({ resets: 2, calls });
  const response = await respond({ request: request(TOKEN), body: { confirm: "RESET" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "reset", removed: 2 });
  expect(calls.count).toBe(1);
});
