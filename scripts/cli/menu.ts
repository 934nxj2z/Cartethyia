import Enquirer from "enquirer";

/**
 * One row in a menu: an action the caller can run, or a rule between groups.
 *
 * Rules are rendered by `enquirer`'s own separator role and are never
 * selectable, so the caller's action list stays a plain array indexed by the
 * rows the operator can actually pick.
 */
export type MenuRow =
  | { readonly kind: "action"; readonly label: string; readonly hint?: string }
  | { readonly kind: "rule" };

/**
 * A single-select menu driven by the arrow keys and Enter.
 *
 * Built on `enquirer` rather than a hand-rolled raw-mode listener: a raw
 * `process.stdin.on("keypress")` handler never fires unless something first
 * calls `readline.emitKeypressEvents`, and the menu rendered as inert text for
 * exactly that reason. `enquirer` owns the keypress plumbing, including Ctrl-C.
 *
 * `header` is printed once here and never handed to `enquirer`: enquirer
 * redraws its whole frame on every keypress, so a header inside the prompt
 * repeated once per keystroke and stacked the wordmark down the terminal.
 *
 * Returns -1 when stdin is not a TTY (piped, CI, or a non-interactive run) or
 * when the operator cancels, so the caller can drain and exit either way.
 */
export async function chooseFromMenu(
  header: string | readonly string[],
  rows: readonly MenuRow[],
): Promise<number> {
  if (!process.stdin.isTTY) return -1;

  const headerLines = typeof header === "string" ? [header] : header;
  process.stdout.write("\u001b[2J\u001b[H");
  for (const line of headerLines) process.stdout.write(`${line}\n`);
  process.stdout.write("\n");

  // Enquirer indexes the rows it renders, rules included, so the action index
  // has to be recovered from the label rather than from the position.
  const labels = rows.flatMap((row) => (row.kind === "action" ? [row.label] : []));


  try {
    const answer = await Enquirer.prompt<{ choice: string }>({
      type: "select",
      name: "choice",
      message: "Select an action",
      choices: rows.map((row) =>
        row.kind === "rule"
          ? { name: "rule", message: "", role: "separator" }
          : {
              name: row.label,
              message: row.label,
              ...(row.hint === undefined ? {} : { hint: row.hint }),
            },
      ),
      initial: 0,
    });
    return labels.indexOf(answer.choice);
  } catch {
    // Enquirer rejects on Esc and on its own Ctrl-C handling. Return -1 so the
    // caller drains the gateway rather than leaving a detached process behind.
    process.stdout.write("\u001b[2J\u001b[H");
    return -1;
  }
}

/**
 * Asks the operator to type an exact word before a destructive action runs.
 *
 * Enter alone must not be enough: the reset deletes every console credential,
 * so the operator types the word rather than confirming a highlight. Returns
 * false on cancel, on a mismatch, or when stdin is not a TTY.
 */
export async function confirmByTyping(word: string, message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  try {
    const answer = await Enquirer.prompt<{ confirmation: string }>({
      type: "input",
      name: "confirmation",
      message: `${message} (type ${word})`,
      validate: (value: string) =>
        value.trim() === word ? true : `type ${word} exactly to confirm, or Ctrl-C to cancel`,
    });
    return answer.confirmation.trim() === word;
  } catch {
    return false;
  }
}

/** A yes/no gate for the step before the typed confirmation. */
export async function confirmStep(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  try {
    const answer = await Enquirer.prompt<{ proceed: boolean }>({
      type: "confirm",
      name: "proceed",
      message,
      initial: false,
    });
    return answer.proceed;
  } catch {
    return false;
  }
}
