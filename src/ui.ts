import { clearLine, cursorTo } from "readline";

export const CHECK = "✓";
export const CROSS = "✗";
export const QUESTION = "?";

export function color(
  value: string,
  colorName: "green" | "red" | "yellow"
): string {
  const code = colorName === "green" ? 32 : colorName === "red" ? 31 : 33;
  return `\u001b[${code}m${value}\u001b[0m`;
}

export function visibleLength(value: string): number {
  return value.replace(/\u001b\[[0-9;]*m/g, "").length;
}

export function formatRow(row: string[], widths: number[]): string {
  return row
    .map(
      (value, index) => value + " ".repeat(widths[index] - visibleLength(value))
    )
    .join("  ");
}

export function printTable(
  headers: string[],
  rows: { network: string; cells: { label: string }[] }[],
  caption: string[]
): void {
  const body = rows.map((row) => [
    row.network,
    ...row.cells.map((c) => c.label),
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...body.map((row) => visibleLength(row[index])))
  );

  console.log(formatRow(headers, widths));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of body) {
    console.log(formatRow(row, widths));
  }
  console.log();
  console.log(caption.join("  "));
}

export function renderProgress(
  completed: number,
  total: number,
  label = "Checking deployments"
): void {
  if (!process.stderr.isTTY) return;
  cursorTo(process.stderr, 0);
  process.stderr.write(`${label}: ${completed}/${total} requests`);
}

export function clearProgress(): void {
  if (!process.stderr.isTTY) return;
  cursorTo(process.stderr, 0);
  clearLine(process.stderr, 0);
}

export function showTransient(message: string): void {
  if (!process.stderr.isTTY) return;
  clearProgress();
  cursorTo(process.stderr, 0);
  process.stderr.write(message);
}

export function printStatusLine(message: string): void {
  clearProgress();
  console.log(message);
}
