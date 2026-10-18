/**
 * The console wordmark.
 *
 * Rendered with half-block characters so each letter is two pixel rows tall in
 * one character cell, and coloured with a horizontal gradient across the
 * Cartethyia blue-grey range. The caller decides whether to print it: a
 * non-colour terminal, or one narrower than the wordmark, should skip it.
 */

const WORDMARK: readonly string[] = [
  " ██████╗ █████╗ ██████╗ ████████╗███████╗████████╗██╗  ██╗██╗   ██╗██╗ █████╗ ",
  "██╔════╝██╔══██╗██╔══██╗╚══██╔══╝██╔════╝╚══██╔══╝██║  ██║╚██╗ ██╔╝██║██╔══██╗",
  "██║     ███████║██████╔╝   ██║   █████╗     ██║   ███████║ ╚████╔╝ ██║███████║",
  "██║     ██╔══██║██╔══██╗   ██║   ██╔══╝     ██║   ██╔══██║  ╚██╔╝  ██║██╔══██║",
  "╚██████╗██║  ██║██║  ██║   ██║   ███████╗   ██║   ██║  ██║   ██║   ██║██║  ██║",
  " ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   ╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚═╝╚═╝  ╚═╝",
];

/** Blue-grey gradient: dim at the edges, brighter through the middle. */
const GRADIENT: readonly [number, number, number][] = [
  [90, 120, 150],
  [120, 160, 200],
  [150, 200, 240],
  [120, 160, 200],
  [90, 120, 150],
];

const RESET = "\u001b[0m";

/**
 * Returns the wordmark lines with per-column colour, or an empty array when the
 * terminal is too narrow or colour is disabled.
 */
export function renderWordmark(columns = process.stdout.columns ?? 80): string[] {
  if (process.env.NO_COLOR !== undefined) return [];
  const width = WORDMARK[0]!.length;
  if (columns < width) return [];

  const coloured: string[] = [];
  for (const row of WORDMARK) {
    let line = "";
    let current = -1;
    for (let column = 0; column < row.length; column += 1) {
      const band = Math.min(
        GRADIENT.length - 1,
        Math.floor((column / width) * GRADIENT.length),
      );
      const [r, g, b] = GRADIENT[band]!;
      if (band !== current) {
        line += `\u001b[38;2;${r};${g};${b}m`;
        current = band;
      }
      line += row[column];
    }
    coloured.push(`${line}${RESET}`);
  }
  return coloured;
}
