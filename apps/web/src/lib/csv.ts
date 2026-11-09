/** Quotes one CSV field. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value) || /^[=+\-@\t]/.test(value)) {
    // A leading = + - @ could be run as a formula by a spreadsheet.
    const safe = /^[=+\-@\t]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows]
    .map((row) => row.map(csvField).join(","))
    .join("\r\n");
}

/** Hands the viewer a file to save. */
export function downloadText(
  filename: string,
  text: string,
  type = "text/csv",
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
