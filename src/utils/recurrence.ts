/**
 * Expand TimeTree recurring events into occurrence instants.
 *
 * Verified shape of the unofficial API (not guessed):
 * - Each series is one event. `recurrences` is an array of iCalendar lines, not
 *   expanded instances. Confirmed by TimeTree's own engineering note
 *   (https://zenn.dev/timetree/articles/de2520378b5415): editing one date appends
 *   a line such as `"EXDATE:20250522"`, and the web client expands `RRULE` /
 *   `EXDATE` / `RDATE` with rrule.js. Datetime exceptions look like
 *   `EXDATE:20250716T090000Z`. Lunar dates are stored as `RDATE:20250522,...`.
 * - TimeTree-Exporter maps that same field onto RRULE, EXDATE, and RDATE, and
 *   uses `recurring_uuid` as the series id of a detached (edited) instance.
 * - Sync payloads include `recurrences: []` and `recurring_uuid` (see
 *   hermes-timetree-sync's captured `/events/sync` body).
 *
 * Timed events repeat at the same wall-clock time in `start_timezone`.
 * All-day events are stored at UTC midnight; expand those in UTC so the UTC
 * date does not drift through a timezone offset or DST gap.
 *
 * Supported rules: FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with INTERVAL, COUNT,
 * UNTIL (date or UTC datetime), BYDAY (including ordinals such as 2TU,-1FR),
 * BYMONTHDAY, BYMONTH, BYSETPOS, and WKST. Anything else returns null so the
 * caller can leave the series unexpanded instead of inventing dates.
 */

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_PERIODS = 100_000;
const SUPPORTED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
]);

export interface LocalDate {
  year: number;
  month: number; // 1-12
  day: number;
}

interface LocalTime {
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
}

type LocalDateTime = LocalDate & LocalTime;

type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

interface ByDay {
  weekday: number;
  ordinal?: number;
}

/** A DATE or DATE-TIME token from EXDATE, RDATE, or UNTIL. */
export interface DateToken {
  kind: 'date' | 'utc' | 'floating';
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  /** IANA zone from a TZID parameter. Only meaningful for floating values. */
  timeZone?: string;
}

interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  until?: DateToken;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  weekStart: number;
}

export interface ParsedRecurrence {
  rule: Rule | null;
  exdates: DateToken[];
  rdates: DateToken[];
}

export interface ExpandOptions {
  /** Series start, epoch milliseconds. */
  start: number;
  /**
   * Zone whose wall clock repeats. Ignored for all-day events, which are
   * expanded in UTC.
   */
  timeZone?: string;
  allDay?: boolean;
  /** Inclusive. */
  windowStart: number;
  /** Exclusive. */
  windowEnd: number;
  maxOccurrences: number;
}

export interface ExpandResult {
  occurrences: number[];
  /** True when the occurrence cap or the period safety limit cut the result short. */
  truncated: boolean;
}

/** Keep string recurrence lines; non-strings are JSON-encoded so nothing is dropped. */
export function stringRecurrences(lines: unknown): string[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Timed events use their start zone; all-day events stay on the UTC date. */
export function occurrenceTimeZone(event: {
  all_day?: boolean;
  start_timezone?: string | null;
}): string {
  if (event.all_day) return 'UTC';
  if (event.start_timezone && isValidTimeZone(event.start_timezone)) return event.start_timezone;
  return 'Asia/Tokyo';
}

export function parseCalendarDate(value: string): LocalDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function addCalendarDays(date: LocalDate, days: number): LocalDate {
  return addDays(date, days);
}

export function compareCalendarDates(a: LocalDate, b: LocalDate): number {
  return compareDates(a, b);
}

/** UTC instant of local midnight in `timeZone`. */
export function zonedMidnightUtc(date: LocalDate, timeZone: string): number {
  return fromLocal(date, { hour: 0, minute: 0, second: 0 }, formatterFor(timeZone));
}

/**
 * Parse TimeTree `recurrences` lines. Returns null when a rule is present but
 * uses syntax this expander does not implement.
 */
export function parseRecurrence(lines: unknown): ParsedRecurrence | null {
  if (!Array.isArray(lines)) return null;
  // Only real iCalendar lines are rules. Non-strings are preserved on output
  // by stringRecurrences, but they are not a recurrence we can expand.
  const raw = lines.filter((line): line is string => typeof line === 'string' && line.trim().length > 0);
  if (!raw.length) return null;

  let rule: Rule | null = null;
  let sawRule = false;
  const exdates: DateToken[] = [];
  const rdates: DateToken[] = [];

  for (const line of raw) {
    const property = parseProperty(line);
    if (!property) continue;
    if (property.name === 'RRULE') {
      if (sawRule) return null;
      sawRule = true;
      rule = parseRule(property.value);
      if (!rule) return null;
    } else if (property.name === 'EXDATE') {
      const tokens = parseDateList(property.value, property.params.get('TZID'));
      if (!tokens) return null;
      exdates.push(...tokens);
    } else if (property.name === 'RDATE') {
      const tokens = parseDateList(property.value, property.params.get('TZID'));
      if (!tokens) return null;
      rdates.push(...tokens);
    }
  }

  if (!rule && !rdates.length) return null;
  return { rule, exdates, rdates };
}

/** Occurrence start times (epoch ms) inside [windowStart, windowEnd). */
export function expandRecurrence(recurrence: ParsedRecurrence, options: ExpandOptions): ExpandResult {
  if (!(options.windowStart < options.windowEnd) || options.maxOccurrences < 1) {
    return { occurrences: [], truncated: false };
  }

  const timeZone = options.allDay ? 'UTC' : options.timeZone && isValidTimeZone(options.timeZone) ? options.timeZone : 'Asia/Tokyo';
  const formatter = formatterFor(timeZone);
  const occurrences: number[] = [];
  let truncated = false;

  if (recurrence.rule) {
    const generated = expandRule(recurrence, options, formatter, occurrences);
    truncated = generated.truncated;
  }

  for (const token of recurrence.rdates) {
    if (occurrences.length >= options.maxOccurrences) {
      truncated = true;
      break;
    }
    const instant = tokenToInstant(token, options, formatter);
    if (instant === null) continue;
    if (instant < options.windowStart || instant >= options.windowEnd) continue;
    if (isExcluded(recurrence.exdates, instant, toLocal(instant, formatter), formatter)) continue;
    occurrences.push(instant);
  }

  occurrences.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const instant of occurrences) {
    if (unique[unique.length - 1] !== instant) unique.push(instant);
  }
  if (unique.length > options.maxOccurrences) {
    return { occurrences: unique.slice(0, options.maxOccurrences), truncated: true };
  }
  return { occurrences: unique, truncated };
}

function expandRule(
  recurrence: ParsedRecurrence,
  options: ExpandOptions,
  formatter: Intl.DateTimeFormat,
  into: number[]
): { truncated: boolean } {
  const rule = recurrence.rule;
  if (!rule) return { truncated: false };

  const startLocal = toLocal(options.start, formatter);
  const startDate: LocalDate = { year: startLocal.year, month: startLocal.month, day: startLocal.day };
  const startTime: LocalTime = {
    hour: startLocal.hour,
    minute: startLocal.minute,
    second: startLocal.second,
    millisecond: new Date(options.start).getUTCMilliseconds(),
  };
  const windowEndLocal = toLocal(options.windowEnd - 1, formatter);
  const windowEndDate: LocalDate = {
    year: windowEndLocal.year,
    month: windowEndLocal.month,
    day: windowEndLocal.day,
  };

  let generated = 0;
  let stopped = false;

  for (let period = 0; period < MAX_PERIODS && !stopped; period++) {
    const anchor = periodAnchor(rule, startDate, period);
    if (compareDates(anchor, windowEndDate) > 0) break;

    for (const date of periodDates(rule, startDate, period)) {
      if (compareDates(date, startDate) < 0) continue;

      const instant =
        compareDates(date, startDate) === 0
          ? options.start
          : fromLocal(date, startTime, formatter);

      if (pastUntil(rule, date, instant, formatter)) {
        stopped = true;
        break;
      }
      if (rule.count !== undefined && generated >= rule.count) {
        stopped = true;
        break;
      }
      generated += 1;

      if (instant >= options.windowEnd) {
        stopped = true;
        break;
      }
      if (instant < options.windowStart) continue;
      if (isExcluded(recurrence.exdates, instant, { ...date, ...startTime }, formatter)) continue;

      into.push(instant);
      if (into.length >= options.maxOccurrences) {
        return { truncated: true };
      }
    }
  }

  if (!stopped && compareDates(periodAnchor(rule, startDate, MAX_PERIODS), windowEndDate) <= 0) {
    return { truncated: true };
  }
  return { truncated: false };
}

function tokenToInstant(
  token: DateToken,
  options: ExpandOptions,
  formatter: Intl.DateTimeFormat
): number | null {
  if (token.kind === 'utc') {
    return Date.UTC(token.year, token.month - 1, token.day, token.hour ?? 0, token.minute ?? 0, token.second ?? 0);
  }
  const startLocal = toLocal(options.start, formatter);
  const time: LocalTime =
    token.kind === 'floating'
      ? { hour: token.hour ?? 0, minute: token.minute ?? 0, second: token.second ?? 0 }
      : { hour: startLocal.hour, minute: startLocal.minute, second: startLocal.second };
  const zoneFormatter =
    token.timeZone && isValidTimeZone(token.timeZone) ? formatterFor(token.timeZone) : formatter;
  return fromLocal({ year: token.year, month: token.month, day: token.day }, time, zoneFormatter);
}

function pastUntil(rule: Rule, date: LocalDate, instant: number, formatter: Intl.DateTimeFormat): boolean {
  const until = rule.until;
  if (!until) return false;
  if (until.kind === 'date') return compareDates(date, until) > 0;
  const untilInstant =
    until.kind === 'utc'
      ? Date.UTC(until.year, until.month - 1, until.day, until.hour ?? 0, until.minute ?? 0, until.second ?? 0)
      : fromLocal(
          until,
          { hour: until.hour ?? 0, minute: until.minute ?? 0, second: until.second ?? 0 },
          until.timeZone && isValidTimeZone(until.timeZone) ? formatterFor(until.timeZone) : formatter
        );
  return instant > untilInstant;
}

function isExcluded(
  exdates: DateToken[],
  instant: number,
  nominal: LocalDateTime,
  formatter: Intl.DateTimeFormat
): boolean {
  for (const token of exdates) {
    if (token.kind === 'date') {
      if (nominal.year === token.year && nominal.month === token.month && nominal.day === token.day) return true;
      continue;
    }
    if (token.kind === 'utc') {
      const ex = Date.UTC(token.year, token.month - 1, token.day, token.hour ?? 0, token.minute ?? 0, token.second ?? 0);
      if (ex === instant) return true;
      continue;
    }
    const zoneFormatter =
      token.timeZone && isValidTimeZone(token.timeZone) ? formatterFor(token.timeZone) : formatter;
    const ex = fromLocal(
      token,
      { hour: token.hour ?? 0, minute: token.minute ?? 0, second: token.second ?? 0 },
      zoneFormatter
    );
    if (ex === instant) return true;
  }
  return false;
}

function parseProperty(line: string): { name: string; params: Map<string, string>; value: string } | null {
  const separator = line.indexOf(':');
  if (separator <= 0) return null;
  const left = line.slice(0, separator).trim();
  const value = line.slice(separator + 1).trim();
  const [rawName, ...rawParams] = left.split(';');
  if (!rawName) return null;
  const params = new Map<string, string>();
  for (const part of rawParams) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    params.set(part.slice(0, eq).trim().toUpperCase(), part.slice(eq + 1).trim());
  }
  return { name: rawName.trim().toUpperCase(), params, value };
}

function parseDateList(value: string, tzid: string | undefined): DateToken[] | null {
  const tokens: DateToken[] = [];
  for (const item of value.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const token = parseDateToken(trimmed, tzid);
    if (!token) return null;
    tokens.push(token);
  }
  return tokens;
}

function parseDateToken(value: string, tzid: string | undefined): DateToken | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (!match[4]) {
    return { kind: 'date', year, month, day, timeZone: tzid };
  }
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (match[7]) return { kind: 'utc', year, month, day, hour, minute, second };
  return { kind: 'floating', year, month, day, hour, minute, second, timeZone: tzid };
}

function parseRule(value: string): Rule | null {
  const parts = new Map<string, string>();
  for (const pair of value.split(';')) {
    if (!pair.trim()) continue;
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    parts.set(pair.slice(0, eq).trim().toUpperCase(), pair.slice(eq + 1).trim().toUpperCase());
  }

  for (const key of parts.keys()) {
    if (!SUPPORTED_PARTS.has(key)) return null;
  }

  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;

  const byDay: ByDay[] = [];
  for (const token of (parts.get('BYDAY') ?? '').split(',').filter(Boolean)) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
    if (!match || !match[2]) return null;
    const ordinal = match[1] ? Number(match[1]) : undefined;
    if (ordinal === 0) return null;
    if (ordinal !== undefined && (freq === 'DAILY' || freq === 'WEEKLY')) return null;
    const weekday = WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]);
    byDay.push({ weekday, ordinal });
  }

  const byMonthDay = parseNumberList(parts.get('BYMONTHDAY'));
  const byMonth = parseNumberList(parts.get('BYMONTH'));
  const bySetPos = parseNumberList(parts.get('BYSETPOS'));
  if (!byMonthDay || !byMonth || !bySetPos) return null;
  if (byMonth.some((month) => month < 1 || month > 12)) return null;
  if (byMonthDay.some((day) => day < -31 || day > 31)) return null;

  // Year-scoped ordinals ("the 20th Monday of the year") are not expanded.
  if (freq === 'YEARLY' && !byMonth.length && !byMonthDay.length && byDay.some((day) => day.ordinal !== undefined)) {
    return null;
  }
  if (freq === 'WEEKLY' && byMonthDay.length) return null;

  let until: DateToken | undefined;
  const untilValue = parts.get('UNTIL');
  if (untilValue !== undefined) {
    const token = parseDateToken(untilValue, undefined);
    if (!token) return null;
    until = token;
  }

  const interval = parts.has('INTERVAL') ? Number(parts.get('INTERVAL')) : 1;
  const count = parts.has('COUNT') ? Number(parts.get('COUNT')) : undefined;
  if (!Number.isInteger(interval) || interval < 1) return null;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) return null;

  const weekStart = WEEKDAYS.indexOf((parts.get('WKST') ?? 'MO') as (typeof WEEKDAYS)[number]);
  if (weekStart < 0) return null;

  return { freq, interval, count, until, byDay, byMonthDay, byMonth, bySetPos, weekStart };
}

function parseNumberList(value: string | undefined): number[] | null {
  if (!value) return [];
  const numbers = value.split(',').filter(Boolean).map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n === 0)) return null;
  return numbers;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

function toLocal(instant: number, formatter: Intl.DateTimeFormat): LocalDateTime {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  let { year, month, day, hour, minute, second } = values;
  // Some Intl builds report midnight as hour 24 on the previous day.
  if (hour === 24) {
    hour = 0;
    const next = addDays({ year, month, day }, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return { year, month, day, hour, minute, second };
}

function offsetAt(instant: number, formatter: Intl.DateTimeFormat): number {
  const local = toLocal(instant, formatter);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - instant;
}

/**
 * Wall-clock time in the formatter's zone to epoch ms.
 * Ambiguous times (fall back) use the earlier instant. Times that fall in a
 * spring-forward gap use the offset in effect before the gap (RFC 5545).
 */
function fromLocal(date: LocalDate, time: LocalTime, formatter: Intl.DateTimeFormat): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second);
  const offsetBefore = offsetAt(wallAsUtc - 2 * DAY_MS, formatter);
  const offsetAfter = offsetAt(wallAsUtc + 2 * DAY_MS, formatter);
  const matches = [offsetBefore, offsetAfter]
    .map((offset) => wallAsUtc - offset)
    .filter((instant) => offsetAt(instant, formatter) === wallAsUtc - instant);
  const resolved = (matches.length ? Math.min(...matches) : wallAsUtc - offsetBefore) + (time.millisecond ?? 0);
  return resolved;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function addDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function compareDates(a: LocalDate, b: LocalDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function applySetPos(dates: LocalDate[], setPos: number[]): LocalDate[] {
  if (!setPos.length) return dates;
  const picked = new Set<number>();
  for (const n of setPos) {
    const index = n > 0 ? n - 1 : dates.length + n;
    if (index >= 0 && index < dates.length) picked.add(index);
  }
  return [...picked].sort((a, b) => a - b).map((index) => dates[index]);
}

/** Days in one month selected by BYMONTHDAY / BYDAY, before BYSETPOS. */
function monthCandidates(year: number, month: number, rule: Rule, start: LocalDate): LocalDate[] {
  const length = daysInMonth(year, month);
  let days: Set<number> | null = null;

  const limit = (next: Set<number>) => {
    days = days === null ? next : new Set([...days].filter((day) => next.has(day)));
  };

  if (rule.byMonthDay.length) {
    const set = new Set<number>();
    for (const n of rule.byMonthDay) {
      const day = n > 0 ? n : length + n + 1;
      if (day >= 1 && day <= length) set.add(day);
    }
    limit(set);
  }

  if (rule.byDay.length) {
    const set = new Set<number>();
    for (const { weekday, ordinal } of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1; day <= length; day++) {
        if (weekdayOf({ year, month, day }) === weekday) matching.push(day);
      }
      if (ordinal === undefined) {
        matching.forEach((day) => set.add(day));
      } else {
        const day = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
        if (day !== undefined) set.add(day);
      }
    }
    limit(set);
  }

  if (days === null) {
    days = start.day <= length ? new Set([start.day]) : new Set();
  }

  return [...days].sort((a, b) => a - b).map((day) => ({ year, month, day }));
}

function weekStartDate(date: LocalDate, weekStart: number): LocalDate {
  const offset = (weekdayOf(date) - weekStart + 7) % 7;
  return addDays(date, -offset);
}

function periodAnchor(rule: Rule, start: LocalDate, period: number): LocalDate {
  switch (rule.freq) {
    case 'DAILY':
      return addDays(start, period * rule.interval);
    case 'WEEKLY':
      return addDays(weekStartDate(start, rule.weekStart), period * rule.interval * 7);
    case 'MONTHLY': {
      const monthIndex = start.year * 12 + (start.month - 1) + period * rule.interval;
      return { year: Math.floor(monthIndex / 12), month: (monthIndex % 12) + 1, day: 1 };
    }
    case 'YEARLY':
      return { year: start.year + period * rule.interval, month: 1, day: 1 };
  }
}

function periodDates(rule: Rule, start: LocalDate, period: number): LocalDate[] {
  switch (rule.freq) {
    case 'DAILY': {
      const date = addDays(start, period * rule.interval);
      if (rule.byMonth.length && !rule.byMonth.includes(date.month)) return [];
      if (rule.byDay.length && !rule.byDay.some((day) => day.weekday === weekdayOf(date))) return [];
      if (rule.byMonthDay.length) {
        const length = daysInMonth(date.year, date.month);
        const match = rule.byMonthDay.some((n) => (n > 0 ? n : length + n + 1) === date.day);
        if (!match) return [];
      }
      return applySetPos([date], rule.bySetPos);
    }
    case 'WEEKLY': {
      const week = addDays(weekStartDate(start, rule.weekStart), period * rule.interval * 7);
      const weekdays = rule.byDay.length ? rule.byDay.map((day) => day.weekday) : [weekdayOf(start)];
      const dates = [0, 1, 2, 3, 4, 5, 6]
        .map((offset) => addDays(week, offset))
        .filter((date) => weekdays.includes(weekdayOf(date)))
        .filter((date) => !rule.byMonth.length || rule.byMonth.includes(date.month));
      return applySetPos(dates, rule.bySetPos);
    }
    case 'MONTHLY': {
      const monthIndex = start.year * 12 + (start.month - 1) + period * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(month)) return [];
      return applySetPos(monthCandidates(year, month, rule, start), rule.bySetPos);
    }
    case 'YEARLY': {
      const year = start.year + period * rule.interval;
      const months = rule.byMonth.length
        ? [...rule.byMonth].sort((a, b) => a - b)
        : rule.byDay.length || rule.byMonthDay.length
          ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
          : [start.month];
      const dates = months.flatMap((month) => monthCandidates(year, month, rule, start));
      return applySetPos(dates, rule.bySetPos);
    }
  }
}
