/**
 * The update path, which prints a command rather than running one.
 *
 * npm cannot replace this package's directory while a process is executing out
 * of it: on Windows the rename fails with EBUSY and npm exits 14. Stopping the
 * gateway is not enough either, because the CLI or tray itself is the process
 * holding the directory. So every caller stops, prints the command, and exits —
 * the same shape 9router uses.
 */
export function updateCommand(): string {
  return "npm install -g cartethyia@latest --prefer-online";
}

/** Prints the "run this now" block after Cartethyia has stopped. */
export function printUpdateInstructions(from: string, to: string | null): void {
  console.log("");
  console.log(`Update available: ${from} \u2192 ${to ?? "latest"}`);
  console.log("");
  console.log("Run this now that Cartethyia has stopped:");
  console.log("");
  console.log(`   ${updateCommand()}`);
  console.log("");
}
