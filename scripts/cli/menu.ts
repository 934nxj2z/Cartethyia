/**
 * A single-select menu driven by the arrow keys and Enter, built on stdin raw
 * mode so no menu dependency is added. It only reads keys and returns an
 * index; the caller keeps owning whatever the menu acts on.
 *
 * `header` is rendered above the list — the caller passes lines such as the
 * running version and the URL, so the menu never has to know what it is
 * driving. It accepts one string or several.
 *
 * Returns -1 when stdin is not a TTY (piped, CI, or a non-interactive run) so
 * callers can fall back without blocking on input that will never arrive.
 */
export function chooseFromMenu(
  header: string | readonly string[],
  options: readonly string[],
): Promise<number> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve(-1);
  const { promise, resolve } = Promise.withResolvers<number>();
  const headerLines = typeof header === "string" ? [header] : header;
  let index = 0;

  const render = (): void => {
    process.stdout.write("\u001b[2J\u001b[H");
    for (const line of headerLines) process.stdout.write(`${line}\n`);
    process.stdout.write("\n");
    options.forEach((option, position) => {
      const marker = position === index ? "\u2192" : " ";
      process.stdout.write(`  ${marker} ${option}\n`);
    });
    process.stdout.write("\n\u2191\u2193 move \u00b7 Enter choose \u00b7 Esc/q exit\n");
  };
  const cleanup = (choice: number): void => {
    stdin.setRawMode(false);
    stdin.off("keypress", onKey);
    stdin.pause();
    process.stdout.write("\u001b[2J\u001b[H");
    resolve(choice);
  };
  const onKey = (_chunk: unknown, key: { name?: string }): void => {
    if (key.name === "up") {
      index = (index - 1 + options.length) % options.length;
      render();
      return;
    }
    if (key.name === "down") {
      index = (index + 1) % options.length;
      render();
      return;
    }
    if (key.name === "return") {
      cleanup(index);
      return;
    }
    if (key.name === "escape" || key.name === "q") cleanup(-1);
  };

  stdin.setRawMode(true);
  stdin.resume();
  render();
  stdin.on("keypress", onKey);
  return promise;
}
