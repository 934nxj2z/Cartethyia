import Enquirer from "enquirer";

/**
 * A single-select menu driven by the arrow keys and Enter.
 *
 * Built on `enquirer` rather than a hand-rolled raw-mode listener: a raw
 * `process.stdin.on("keypress")` handler never fires unless something first
 * calls `readline.emitKeypressEvents`, and the menu rendered as inert text for
 * exactly that reason. `enquirer` owns the keypress plumbing.
 *
 * `header` is rendered above the list — the caller passes lines such as the
 * running version and the URL, so the menu never has to know what it drives.
 *
 * Returns -1 when stdin is not a TTY (piped, CI, or a non-interactive run) so
 * callers can fall back without blocking on input that will never arrive.
 */
export async function chooseFromMenu(
  header: string | readonly string[],
  options: readonly string[],
): Promise<number> {
  if (!process.stdin.isTTY) return -1;
  const headerLines = typeof header === "string" ? [header] : header;
  for (const line of headerLines) console.log(line);
  console.log("");

  try {
    const answer = await Enquirer.prompt<{ choice: string }>({
      type: "select",
      name: "choice",
      message: "Select an action",
      choices: options.map((label) => ({ name: label, message: label })),
      initial: 0,
    });
    const index = options.indexOf(answer.choice);
    return index >= 0 ? index : -1;
  } catch {
    // Enquirer rejects when the prompt is cancelled (Ctrl-C or Esc).
    return -1;
  }
}
