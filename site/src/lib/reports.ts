/**
 * The monthly reports: one entry per report page under /report. A report is dated:
 * it reads the run that its dataset was written from, so the page and the file say the same.
 */
export interface Report {
  /** YYYY-MM, the path under /report. */
  month: string;
  title: string;
  /** The day of the run the report and the dataset are built from (ISO date). */
  run: string;
  /** The first full run the report compares against (ISO date). */
  from: string;
  /** The dataset: a static file of the site, gzip of a JSON document, CC BY 4.0. */
  dataset: { path: string; size: string };
}

export const REPORTS: Report[] = [
  {
    month: '2026-10',
    title: 'The state of the MCP registry, October 2026',
    run: '2026-10-24',
    from: '2026-10-03',
    dataset: { path: '/data/mcpcost-2026-10.json.gz', size: '1.2 MB' }
  }
];

/** The next month as an ISO prefix, for the end of a half-open range. */
export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}

/** "October 2026" for 2026-10. */
export function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m - 1]} ${y}`;
}
