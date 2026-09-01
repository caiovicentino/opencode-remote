/**
 * RFC4180-light CSV parsing for the Artifacts pane (P1-010): quoted fields,
 * "" escapes, both \n and \r\n. Pure data — rendered as an HTML table.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushField();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.length > 0 && !(r.length === 1 && r[0] === ""));
}
