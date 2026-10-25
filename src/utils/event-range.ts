/**
 * Choose the rows returned by get_events.
 *
 * Callers that only pass start_after (or nothing) still get one row per series,
 * filtered on the series start. That is the historical behavior. Passing
 * end_before or from/to opts into expanding each series inside that window.
 */

import type { Event } from '../types/timetree.js';
import {
  addCalendarDays,
  compareCalendarDates,
  expandRecurrence,
  isValidTimeZone,
  occurrenceTimeZone,
  parseCalendarDate,
  parseRecurrence,
  stringRecurrences,
  zonedMidnightUtc,
} from './recurrence.js';

export const DEFAULT_RANGE_TIMEZONE = 'Asia/Tokyo';
export const MAX_OCCURRENCES_PER_SERIES = 500;

export class InvalidRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRangeError';
  }
}

export interface RangeQuery {
  startAfter?: number;
  endBefore?: number;
  /** Inclusive YYYY-MM-DD. Single day when `to` is omitted. */
  from?: string;
  /** Inclusive YYYY-MM-DD. Single day when `from` is omitted. */
  to?: string;
  /** IANA zone used to interpret from/to. Defaults to Asia/Tokyo. */
  timezone?: string;
  /**
   * When a range end is set, expand recurring series. Defaults to true.
   * Set false to filter on the series start only.
   */
  expandRecurring?: boolean;
}

export interface EventRow {
  event: Event;
  startAt: number;
  endAt: number;
  occurrence: boolean;
  /** False when the series had a rule we could not expand. */
  recurrenceExpanded?: boolean;
}

export interface ResolvedRange {
  timezone?: string;
  from?: string;
  to?: string;
  start_after?: string;
  end_before?: string;
  /** Null when the window is open on the left (no start_after and no from). */
  start_inclusive: string | null;
  end_exclusive: string;
  /**
   * UTC-midnight bounds used for all-day events when from/to is set.
   * Timed events use start_inclusive/end_exclusive instead.
   */
  all_day_start_inclusive?: string;
  all_day_end_exclusive?: string;
}

export interface UnexpandedSeries {
  uuid: string;
  title: string;
  recurrences: string[];
}

export interface Selection {
  rows: EventRow[];
  expanded: boolean;
  range?: ResolvedRange;
  truncatedSeries: string[];
  unexpandedSeries: UnexpandedSeries[];
}

interface Window {
  /** Instant bounds for timed events (from/to interpreted in `timezone`). */
  startInclusive: number;
  endExclusive: number;
  /**
   * UTC-date bounds for all-day events when from/to is set. All-day events are
   * stored at UTC midnight, so a timezone west of UTC would otherwise move
   * them onto the previous local day.
   */
  allDayStartInclusive?: number;
  allDayEndExclusive?: number;
  range: ResolvedRange;
}

export function selectEventRows(events: Event[], query: RangeQuery): Selection {
  const hasDate = query.from !== undefined || query.to !== undefined;
  const hasEnd = query.endBefore !== undefined || hasDate;
  const expand = hasEnd && query.expandRecurring !== false;
  const window = hasEnd ? resolveWindow(query) : undefined;

  if (!expand) {
    const rows: EventRow[] = [];
    for (const event of events) {
      if (!includesStart(event.start_at, event.all_day, query, window)) continue;
      rows.push({ event, startAt: event.start_at, endAt: event.end_at, occurrence: false });
    }
    return { rows, expanded: false, range: window?.range, truncatedSeries: [], unexpandedSeries: [] };
  }

  if (!window) {
    return { rows: [], expanded: false, truncatedSeries: [], unexpandedSeries: [] };
  }

  const rows: EventRow[] = [];
  const truncatedSeries: string[] = [];
  const unexpandedSeries: UnexpandedSeries[] = [];

  for (const event of events) {
    const recurring = Array.isArray(event.recurrences) && event.recurrences.length > 0;
    const parsed = recurring ? parseRecurrence(event.recurrences) : null;

    if (!parsed) {
      if (includesStart(event.start_at, event.all_day, query, window)) {
        rows.push({
          event,
          startAt: event.start_at,
          endAt: event.end_at,
          occurrence: false,
          ...(recurring ? { recurrenceExpanded: false } : {}),
        });
      } else if (recurring) {
        unexpandedSeries.push({
          uuid: event.uuid,
          title: event.title,
          recurrences: stringRecurrences(event.recurrences),
        });
      }
      continue;
    }

    const duration = event.end_at - event.start_at;
    const bounds = boundsFor(event.all_day, window);
    const { occurrences, truncated } = expandRecurrence(parsed, {
      start: event.start_at,
      timeZone: occurrenceTimeZone(event),
      allDay: event.all_day,
      windowStart: bounds.startInclusive,
      windowEnd: bounds.endExclusive,
      maxOccurrences: MAX_OCCURRENCES_PER_SERIES,
    });

    for (const startAt of occurrences) {
      if (!includesStart(startAt, event.all_day, query, window)) continue;
      rows.push({
        event,
        startAt,
        endAt: startAt + duration,
        occurrence: true,
      });
    }
    if (truncated) truncatedSeries.push(event.uuid);
  }

  rows.sort(
    (a, b) =>
      a.startAt - b.startAt ||
      a.event.title.localeCompare(b.event.title) ||
      a.event.uuid.localeCompare(b.event.uuid)
  );

  return {
    rows,
    expanded: true,
    range: window.range,
    truncatedSeries,
    unexpandedSeries,
  };
}

/** Timed events use the zoned instant window. All-day events use UTC calendar dates. */
function boundsFor(allDay: boolean, window: Window): { startInclusive: number; endExclusive: number } {
  if (allDay && window.allDayStartInclusive !== undefined && window.allDayEndExclusive !== undefined) {
    return { startInclusive: window.allDayStartInclusive, endExclusive: window.allDayEndExclusive };
  }
  return { startInclusive: window.startInclusive, endExclusive: window.endExclusive };
}

function includesStart(start: number, allDay: boolean, query: RangeQuery, window: Window | undefined): boolean {
  if (query.startAfter !== undefined && !(start > query.startAfter)) return false;
  if (!window) return true;
  const bounds = boundsFor(allDay, window);
  if (start < bounds.startInclusive) return false;
  if (start >= bounds.endExclusive) return false;
  return true;
}

function resolveWindow(query: RangeQuery): Window {
  if (query.startAfter !== undefined && !Number.isFinite(query.startAfter)) {
    throw new InvalidRangeError('start_after must be a finite Unix timestamp in milliseconds.');
  }
  if (query.endBefore !== undefined && !Number.isFinite(query.endBefore)) {
    throw new InvalidRangeError('end_before must be a finite Unix timestamp in milliseconds.');
  }

  // start_after stays exclusive and is applied by includesStart. The expander
  // window is inclusive, so begin at start_after itself and drop the equal instant.
  let startInclusive = query.startAfter ?? Number.NEGATIVE_INFINITY;
  let endExclusive = query.endBefore ?? Number.POSITIVE_INFINITY;
  let allDayStartInclusive: number | undefined;
  let allDayEndExclusive: number | undefined;
  let from = query.from;
  let to = query.to;
  let timezone: string | undefined;

  if (from !== undefined || to !== undefined) {
    timezone = query.timezone ?? DEFAULT_RANGE_TIMEZONE;
    if (!isValidTimeZone(timezone)) {
      throw new InvalidRangeError(`Unknown timezone "${timezone}". Use an IANA name such as Asia/Tokyo.`);
    }
    from = from ?? to;
    to = to ?? from;
    const fromDate = from ? parseCalendarDate(from) : null;
    const toDate = to ? parseCalendarDate(to) : null;
    if (!fromDate || !toDate || !from || !to) {
      throw new InvalidRangeError('from and to must be real calendar dates in YYYY-MM-DD form.');
    }
    if (compareCalendarDates(fromDate, toDate) > 0) {
      throw new InvalidRangeError('from must be on or before to.');
    }
    const fromMs = zonedMidnightUtc(fromDate, timezone);
    const toMs = zonedMidnightUtc(addCalendarDays(toDate, 1), timezone);
    startInclusive = Math.max(startInclusive, fromMs);
    endExclusive = Math.min(endExclusive, toMs);
    // All-day rows are dated by the UTC calendar day, not by local midnight.
    const allDayFromMs = Date.UTC(fromDate.year, fromDate.month - 1, fromDate.day);
    const allDayToDate = addCalendarDays(toDate, 1);
    const allDayToMs = Date.UTC(allDayToDate.year, allDayToDate.month - 1, allDayToDate.day);
    allDayStartInclusive = query.startAfter !== undefined ? Math.max(allDayFromMs, query.startAfter) : allDayFromMs;
    allDayEndExclusive = query.endBefore !== undefined ? Math.min(allDayToMs, query.endBefore) : allDayToMs;
  } else if (query.timezone !== undefined && query.timezone !== '' && !isValidTimeZone(query.timezone)) {
    throw new InvalidRangeError(`Unknown timezone "${query.timezone}". Use an IANA name such as Asia/Tokyo.`);
  }

  if (!Number.isFinite(endExclusive)) {
    throw new InvalidRangeError('end_before must be a finite Unix timestamp in milliseconds.');
  }

  return {
    startInclusive,
    endExclusive,
    ...(allDayStartInclusive !== undefined && allDayEndExclusive !== undefined
      ? { allDayStartInclusive, allDayEndExclusive }
      : {}),
    range: {
      ...(timezone ? { timezone } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(query.startAfter !== undefined ? { start_after: new Date(query.startAfter).toISOString() } : {}),
      ...(query.endBefore !== undefined ? { end_before: new Date(query.endBefore).toISOString() } : {}),
      start_inclusive: Number.isFinite(startInclusive) ? new Date(startInclusive).toISOString() : null,
      end_exclusive: new Date(endExclusive).toISOString(),
      ...(allDayStartInclusive !== undefined && allDayEndExclusive !== undefined
        ? {
            all_day_start_inclusive: new Date(allDayStartInclusive).toISOString(),
            all_day_end_exclusive: new Date(allDayEndExclusive).toISOString(),
          }
        : {}),
    },
  };
}
