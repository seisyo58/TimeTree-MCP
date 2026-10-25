import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  expandRecurrence,
  parseRecurrence,
  stringRecurrences,
  zonedMidnightUtc,
} from '../src/utils/recurrence.js';

const TOKYO = 'Asia/Tokyo';

function at(iso: string): number {
  return Date.parse(iso);
}

function expand(
  lines: string[],
  startIso: string,
  windowStartIso: string,
  windowEndIso: string,
  options: { timeZone?: string; allDay?: boolean; max?: number } = {}
) {
  const parsed = parseRecurrence(lines);
  assert.ok(parsed, `expected a parseable rule: ${lines.join(' | ')}`);
  return expandRecurrence(parsed, {
    start: at(startIso),
    timeZone: options.timeZone ?? TOKYO,
    allDay: options.allDay ?? false,
    windowStart: at(windowStartIso),
    windowEnd: at(windowEndIso),
    maxOccurrences: options.max ?? 500,
  });
}

function jstDate(instant: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TOKYO,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')} ${get('weekday')} ${get('hour')}:${get('minute')}`;
}

/** Weekdays of one calendar month, independent of the expander. weekday: 0=Sunday. */
function monthDays(year: number, month: number, weekday: number): number[] {
  const days: number[] = [];
  const length = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= length; day++) {
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === weekday) days.push(day);
  }
  return days;
}

describe('parseRecurrence', () => {
  it('reads RRULE, comma-separated EXDATE, and RDATE lines from the API array', () => {
    const parsed = parseRecurrence([
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TH',
      'EXDATE:20261026,20261025T223000Z',
      'EXDATE;TZID=Asia/Tokyo:20261102T073000',
      'RDATE:20261224',
    ]);
    assert.ok(parsed);
    assert.equal(parsed?.rule?.freq, 'WEEKLY');
    assert.deepEqual(parsed?.rule?.byDay.map((day) => day.weekday), [1, 4]);
    assert.equal(parsed?.exdates.length, 3);
    assert.equal(parsed?.exdates[0]?.kind, 'date');
    assert.equal(parsed?.exdates[1]?.kind, 'utc');
    assert.equal(parsed?.exdates[2]?.kind, 'floating');
    assert.equal(parsed?.exdates[2]?.timeZone, 'Asia/Tokyo');
    assert.equal(parsed?.rdates[0]?.kind, 'date');
  });

  it('returns null for rules it must not guess, including the 20th Monday of the year', () => {
    assert.equal(parseRecurrence(['RRULE:FREQ=YEARLY;BYDAY=20MO']), null);
    assert.equal(parseRecurrence(['RRULE:FREQ=HOURLY']), null);
    assert.equal(parseRecurrence([]), null);
    assert.equal(parseRecurrence(undefined), null);
  });

  it('keeps non-string values visible without treating them as rules', () => {
    assert.deepEqual(stringRecurrences([{ freq: 'WEEKLY' }]), ['{"freq":"WEEKLY"}']);
    assert.equal(parseRecurrence([{ freq: 'WEEKLY' }]), null);
  });
});

describe('weekly Mon/Thu in Asia/Tokyo', () => {
  // 燃やすごみ: first instance Thursday 2025-06-26 07:30 JST.
  const start = '2025-06-25T22:30:00.000Z';
  const rule = ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH'];

  it('does not emit the Monday before the series starts', () => {
    const { occurrences } = expand(rule, start, '2025-06-22T15:00:00.000Z', '2025-06-26T15:00:00.000Z');
    assert.deepEqual(occurrences.map((instant) => new Date(instant).toISOString()), [
      '2025-06-25T22:30:00.000Z',
    ]);
    assert.equal(jstDate(occurrences[0]!), '2025-06-26 Thu 07:30');
  });

  it('expands a later week onto Monday and Thursday at 07:30 JST', () => {
    // 2026-10-26 is Monday, 2026-10-29 is Thursday.
    const { occurrences } = expand(rule, start, '2026-10-25T15:00:00.000Z', '2026-10-29T15:00:00.000Z');
    assert.deepEqual(occurrences.map((instant) => new Date(instant).toISOString()), [
      '2026-10-25T22:30:00.000Z',
      '2026-10-28T22:30:00.000Z',
    ]);
    assert.deepEqual(occurrences.map(jstDate), ['2026-10-26 Mon 07:30', '2026-10-29 Thu 07:30']);
  });

  it('matches every Mon/Thu of October 2026 against an independent calendar', () => {
    const expected = [...monthDays(2026, 10, 1), ...monthDays(2026, 10, 4)]
      .sort((a, b) => a - b)
      // 07:30 JST is a fixed UTC+9 offset, so this oracle does not use the expander.
      .map((day) => new Date(Date.UTC(2026, 9, day, 7 - 9, 30, 0)).toISOString());
    const { occurrences } = expand(rule, start, '2026-09-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z');
    assert.deepEqual(occurrences.map((instant) => new Date(instant).toISOString()), expected);
  });

  it('skips a date-only EXDATE, a UTC EXDATE, and a TZID EXDATE', () => {
    const lines = [
      'RRULE:FREQ=WEEKLY;BYDAY=MO,TH',
      'EXDATE:20261026',
      'EXDATE:20261028T223000Z',
      'EXDATE;TZID=Asia/Tokyo:20261005T073000',
    ];
    const { occurrences } = expand(lines, start, '2026-09-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z');
    const dates = occurrences.map(jstDate);
    assert.ok(!dates.includes('2026-10-26 Mon 07:30'));
    assert.ok(!dates.includes('2026-10-29 Thu 07:30'));
    assert.ok(!dates.includes('2026-10-05 Mon 07:30'));
    assert.ok(dates.includes('2026-10-08 Thu 07:30'));
  });

  it('counts an EXDATE toward COUNT and does not replace it with a later date', () => {
    const lines = ['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE:20261027'];
    const { occurrences } = expand(
      lines,
      '2026-10-25T22:30:00.000Z',
      '2026-10-25T15:00:00.000Z',
      '2026-11-05T15:00:00.000Z'
    );
    assert.deepEqual(occurrences.map(jstDate), ['2026-10-26 Mon 07:30', '2026-10-28 Wed 07:30']);
  });
});

describe('monthly 2nd and 4th Tuesday', () => {
  // 2026-01-13 is the 2nd Tuesday of January, 07:30 JST.
  const start = '2026-01-12T22:30:00.000Z';
  const rule = ['RRULE:FREQ=MONTHLY;BYDAY=2TU,4TU'];

  it('returns the 2nd and 4th Tuesday, not the 1st, 3rd, or 5th', () => {
    const tuesdays = monthDays(2026, 9, 2);
    assert.deepEqual(tuesdays, [1, 8, 15, 22, 29]);
    const { occurrences } = expand(rule, start, '2026-08-31T15:00:00.000Z', '2026-09-30T15:00:00.000Z');
    assert.deepEqual(occurrences.map(jstDate), ['2026-09-08 Tue 07:30', '2026-09-22 Tue 07:30']);
  });

  it('accepts the same schedule written with BYSETPOS', () => {
    const ordinal = expand(['RRULE:FREQ=MONTHLY;BYDAY=2TU,4TU'], start, '2026-09-30T15:00:00.000Z', '2026-10-31T15:00:00.000Z');
    const setpos = expand(
      ['RRULE:FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2,4'],
      start,
      '2026-09-30T15:00:00.000Z',
      '2026-10-31T15:00:00.000Z'
    );
    assert.deepEqual(ordinal.occurrences, setpos.occurrences);
    assert.deepEqual(ordinal.occurrences.map(jstDate), ['2026-10-13 Tue 07:30', '2026-10-27 Tue 07:30']);
  });

  it('drops one Tuesday with a date-only EXDATE', () => {
    const { occurrences } = expand(
      ['RRULE:FREQ=MONTHLY;BYDAY=2TU,4TU', 'EXDATE:20260908'],
      start,
      '2026-08-31T15:00:00.000Z',
      '2026-09-30T15:00:00.000Z'
    );
    assert.deepEqual(occurrences.map(jstDate), ['2026-09-22 Tue 07:30']);
  });
});

describe('all-day versus timed', () => {
  it('keeps all-day occurrences on UTC midnight even when start_timezone is not UTC', () => {
    const { occurrences } = expand(
      ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      '2026-03-02T00:00:00.000Z',
      '2026-03-01T00:00:00.000Z',
      '2026-03-16T00:00:00.000Z',
      { timeZone: 'America/New_York', allDay: true }
    );
    assert.deepEqual(occurrences.map((instant) => new Date(instant).toISOString()), [
      '2026-03-02T00:00:00.000Z',
      '2026-03-09T00:00:00.000Z',
    ]);
  });

  it('preserves the local wall clock across a DST change', () => {
    // Monday 09:00 America/New_York. March 8 2026 is the spring-forward.
    const { occurrences } = expand(
      ['RRULE:FREQ=WEEKLY'],
      '2026-03-02T14:00:00.000Z',
      '2026-03-02T05:00:00.000Z',
      '2026-03-10T04:00:00.000Z',
      { timeZone: 'America/New_York' }
    );
    assert.deepEqual(occurrences.map((instant) => new Date(instant).toISOString()), [
      '2026-03-02T14:00:00.000Z', // 09:00 EST
      '2026-03-09T13:00:00.000Z', // 09:00 EDT
    ]);
  });
});

describe('bounds', () => {
  it('includes the UNTIL date and stops after it', () => {
    const { occurrences } = expand(
      ['RRULE:FREQ=DAILY;UNTIL=20261028'],
      '2026-10-25T22:30:00.000Z',
      '2026-10-25T15:00:00.000Z',
      '2026-11-05T15:00:00.000Z'
    );
    assert.deepEqual(occurrences.map(jstDate), [
      '2026-10-26 Mon 07:30',
      '2026-10-27 Tue 07:30',
      '2026-10-28 Wed 07:30',
    ]);
  });

  it('adds lunar-style RDATE days and skips an excluded one', () => {
    const { occurrences } = expand(
      ['RDATE:20260522,20260610,20270530', 'EXDATE:20260610'],
      '2026-05-22T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2028-01-01T00:00:00.000Z',
      { allDay: true, timeZone: 'UTC' }
    );
    assert.deepEqual(occurrences.map((instant) => new Date(instant).toISOString()), [
      '2026-05-22T00:00:00.000Z',
      '2027-05-30T00:00:00.000Z',
    ]);
  });

  it('reports truncation once the per-series cap is hit', () => {
    const { occurrences, truncated } = expand(
      ['RRULE:FREQ=DAILY'],
      '2020-01-01T00:00:00.000Z',
      '2020-01-01T00:00:00.000Z',
      '2022-01-01T00:00:00.000Z',
      { allDay: true, timeZone: 'UTC', max: 500 }
    );
    assert.equal(occurrences.length, 500);
    assert.equal(truncated, true);
    assert.equal(new Date(occurrences[0]!).toISOString(), '2020-01-01T00:00:00.000Z');
  });

  it('places Asia/Tokyo midnight on the previous UTC date', () => {
    assert.equal(
      new Date(zonedMidnightUtc({ year: 2026, month: 10, day: 26 }, TOKYO)).toISOString(),
      '2026-10-25T15:00:00.000Z'
    );
  });
});
