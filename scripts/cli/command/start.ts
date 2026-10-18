import { ensureDrainToken } from "../gateway/drain-token";

/**
 * Runs the gateway in the foreground, in this process.
 *
 * A foreground run still needs a drain token on disk: the gateway registers
 * `/admin/drain` only when one is set, and "Hide to tray" hands this run to a
 * tray that drains it through that route.
 */
export async function startForeground(): Promise<void> {
  process.env.CARTETHYIA_DRAIN_TOKEN ??= ensureDrainToken();
  await import("../../../src/main");
}
