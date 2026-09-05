// A widget under a collapsed pill is a resting surface, not the place to read 5,000 rows. On the
// 150-card drill board one such pill carried a 5,000-row data-table: 370,000 of the page's 424,000
// React fibers lived under it, and every layout or style pass on the board paid for them
// (2026-09-05, ENG-467/468/469). The pill gets a screenful; the chat keeps the whole thing.

export const AMBIENT_TABLE_ROWS = 8;

export interface AmbientShape {
  props: Record<string, unknown>;
  /** One line under the widget when something was left out, or null. */
  note: string | null;
}

export function ambientShape(name: string, props: Record<string, unknown>): AmbientShape {
  if (name === 'data-table' && Array.isArray(props.data) && props.data.length > AMBIENT_TABLE_ROWS) {
    const total = props.data.length;
    return {
      props: { ...props, data: props.data.slice(0, AMBIENT_TABLE_ROWS) },
      note: `Showing ${AMBIENT_TABLE_ROWS} of ${total.toLocaleString()} rows. Open the chat for the whole table.`,
    };
  }
  // The vendored stats card stacks its cells vertically under 440 px; the pill is narrower than that.
  if (name === 'stats-display') return { props: { ...props, compact: true }, note: null };
  return { props, note: null };
}
