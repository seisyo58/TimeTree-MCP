import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TimeTreeAPIClient } from '../src/client/api.js';
import { InvalidCalendarError } from '../src/client/api.js';
import type { Event } from '../src/types/timetree.js';
import { createGetEventsTool, createGetUpdatedEventsTool } from '../src/tools/event-tools.js';

const GARBAGE_START = Date.parse('2025-06-25T22:30:00.000Z');
const GARBAGE_END = Date.parse('2025-06-25T22:40:00.000Z');

function event(overrides: Partial<Event> & Pick<Event, 'uuid' | 'title' | 'start_at' | 'end_at'>): Event {
  return {
    id: overrides.uuid,
    calendar_id: 42,
    all_day: false,
    start_timezone: 'Asia/Tokyo',
    end_timezone: 'Asia/Tokyo',
    recurrences: [],
    ...overrides,
  };
}

function garbage(overrides: Partial<Event> = {}): Event {
  return event({
    uuid: 'garbage-series',
    title: '燃やすごみ',
    start_at: GARBAGE_START,
    end_at: GARBAGE_END,
    recurrences: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH'],
    ...overrides,
  });
}

function client(events: Event[], updated: Event[] = events): TimeTreeAPIClient {
  return {
    async getEventsByCalendar() {
      return events;
    },
    async getUpdatedEvents() {
      return updated;
    },
  } as unknown as TimeTreeAPIClient;
}

async function call(tool: { handler: (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }, args: unknown) {
  const result = await tool.handler(args);
  return { body: JSON.parse(result.content[0]!.text) as Record<string, unknown>, isError: result.isError === true };
}

describe('get_events recurrence output', () => {
  it('exposes RRULE lines and does not expand when no range end is given', async () => {
    const tool = createGetEventsTool(client([garbage(), event({
      uuid: 'once',
      title: '歯医者',
      start_at: Date.parse('2026-10-26T01:00:00.000Z'),
      end_at: Date.parse('2026-10-26T02:00:00.000Z'),
    })]));
    const { body } = await call(tool, { calendar_id: '42' });
    const events = body.events as Array<Record<string, unknown>>;
    assert.equal(body.expanded_recurring, false);
    assert.equal(body.range, undefined);
    assert.equal(events.length, 2);
    // API order is preserved when not expanding.
    assert.equal(events[0]!.title, '燃やすごみ');
    assert.equal(events[0]!.start_at, '2025-06-25T22:30:00.000Z');
    assert.equal(events[0]!.has_recurrence, true);
    assert.deepEqual(events[0]!.recurrences, ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH']);
    assert.equal(events[0]!.recurring_uuid, null);
    assert.equal(events[0]!.is_recurring_occurrence, undefined);
    assert.equal(events[1]!.has_recurrence, false);
    assert.deepEqual(events[1]!.recurrences, []);
  });

  it('keeps start_after as a filter on the series start', async () => {
    const tool = createGetEventsTool(client([garbage()]));
    const { body } = await call(tool, {
      calendar_id: '42',
      start_after: Date.parse('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(body.expanded_recurring, false);
    assert.deepEqual(body.events, []);
  });

  it('expands 燃やすごみ for Monday 2026-10-26 in Asia/Tokyo', async () => {
    const tool = createGetEventsTool(client([garbage()]));
    const { body } = await call(tool, { calendar_id: '42', from: '2026-10-26' });
    const events = body.events as Array<Record<string, unknown>>;
    const range = body.range as Record<string, unknown>;

    assert.equal(body.expanded_recurring, true);
    assert.equal(range.timezone, 'Asia/Tokyo');
    assert.equal(range.from, '2026-10-26');
    assert.equal(range.to, '2026-10-26');
    assert.equal(range.start_inclusive, '2026-10-25T15:00:00.000Z');
    assert.equal(range.end_exclusive, '2026-10-26T15:00:00.000Z');
    assert.equal(events.length, 1);
    assert.equal(events[0]!.title, '燃やすごみ');
    assert.equal(events[0]!.start_at, '2026-10-25T22:30:00.000Z');
    assert.equal(events[0]!.end_at, '2026-10-25T22:40:00.000Z');
    assert.equal(events[0]!.is_recurring_occurrence, true);
    assert.equal(events[0]!.series_start_at, '2025-06-25T22:30:00.000Z');
    assert.deepEqual(events[0]!.recurrences, ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH']);
    assert.equal(events[0]!.all_day, false);
  });

  it('expands the same Monday through the following Thursday', async () => {
    const tool = createGetEventsTool(client([garbage()]));
    const { body } = await call(tool, { calendar_id: '42', from: '2026-10-26', to: '2026-10-29' });
    const events = body.events as Array<Record<string, unknown>>;
    assert.deepEqual(
      events.map((row) => row.start_at),
      ['2026-10-25T22:30:00.000Z', '2026-10-28T22:30:00.000Z']
    );
  });

  it('accepts the same window as exclusive start_after and end_before timestamps', async () => {
    const tool = createGetEventsTool(client([garbage()]));
    const { body } = await call(tool, {
      calendar_id: '42',
      start_after: Date.parse('2026-10-25T15:00:00.000Z') - 1,
      end_before: Date.parse('2026-10-26T15:00:00.000Z'),
    });
    const events = body.events as Array<Record<string, unknown>>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.start_at, '2026-10-25T22:30:00.000Z');
  });

  it('omits an EXDATE and still returns the detached replacement on that day', async () => {
    const master = garbage({
      recurrences: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH', 'EXDATE:20261026'],
    });
    const detached = event({
      uuid: 'garbage-oct-26',
      title: '燃やすごみ（収集なし）',
      start_at: Date.parse('2026-10-25T22:30:00.000Z'),
      end_at: Date.parse('2026-10-25T22:40:00.000Z'),
      recurring_uuid: 'garbage-series',
      note: 'この日は収集なし',
    });
    const tool = createGetEventsTool(client([master, detached]));
    const monday = await call(tool, { calendar_id: '42', from: '2026-10-26' });
    const mondayEvents = monday.body.events as Array<Record<string, unknown>>;
    assert.equal(mondayEvents.length, 1);
    assert.equal(mondayEvents[0]!.uuid, 'garbage-oct-26');
    assert.equal(mondayEvents[0]!.recurring_uuid, 'garbage-series');
    assert.equal(mondayEvents[0]!.is_recurring_occurrence, undefined);

    const week = await call(tool, { calendar_id: '42', from: '2026-10-26', to: '2026-10-29' });
    const weekEvents = week.body.events as Array<Record<string, unknown>>;
    assert.deepEqual(
      weekEvents.map((row) => [row.uuid, row.start_at]),
      [
        ['garbage-oct-26', '2026-10-25T22:30:00.000Z'],
        ['garbage-series', '2026-10-28T22:30:00.000Z'],
      ]
    );
  });

  it('expands a 2nd-and-4th-Tuesday monthly event and an all-day weekly event on the same day', async () => {
    const burnable = event({
      uuid: 'nonburn',
      title: '燃えないごみ',
      start_at: Date.parse('2026-01-12T22:30:00.000Z'),
      end_at: Date.parse('2026-01-12T23:00:00.000Z'),
      recurrences: ['RRULE:FREQ=MONTHLY;BYDAY=2TU,4TU'],
    });
    const holiday = event({
      uuid: 'holiday',
      title: '振替休日',
      all_day: true,
      start_timezone: 'Asia/Tokyo',
      end_timezone: 'UTC',
      start_at: Date.parse('2025-06-23T00:00:00.000Z'),
      end_at: Date.parse('2025-06-23T00:00:00.000Z'),
      recurrences: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    });
    const dentist = event({
      uuid: 'dentist',
      title: '歯医者',
      start_at: Date.parse('2026-10-26T01:00:00.000Z'),
      end_at: Date.parse('2026-10-26T02:00:00.000Z'),
    });
    const tool = createGetEventsTool(client([burnable, holiday, dentist, garbage()]));

    const tuesday = await call(tool, { calendar_id: '42', from: '2026-10-13' });
    assert.deepEqual(
      (tuesday.body.events as Array<Record<string, unknown>>).map((row) => row.title),
      ['燃えないごみ']
    );

    const monday = await call(tool, { calendar_id: '42', from: '2026-10-26' });
    const rows = monday.body.events as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((row) => [row.title, row.start_at, row.all_day]),
      [
        ['燃やすごみ', '2026-10-25T22:30:00.000Z', false],
        ['振替休日', '2026-10-26T00:00:00.000Z', true],
        ['歯医者', '2026-10-26T01:00:00.000Z', false],
      ]
    );
  });

  it('can turn expansion off and still filter the series start with from/to', async () => {
    const tool = createGetEventsTool(client([garbage()]));
    const { body } = await call(tool, {
      calendar_id: '42',
      from: '2026-10-26',
      expand_recurring: false,
    });
    assert.equal(body.expanded_recurring, false);
    assert.deepEqual(body.events, []);
  });

  it('caps a long daily series and names it in truncated_series', async () => {
    const daily = event({
      uuid: 'daily',
      title: '毎日',
      all_day: true,
      start_timezone: 'UTC',
      start_at: Date.parse('2020-01-01T00:00:00.000Z'),
      end_at: Date.parse('2020-01-01T00:00:00.000Z'),
      recurrences: ['RRULE:FREQ=DAILY'],
    });
    const tool = createGetEventsTool(client([daily]));
    const { body } = await call(tool, { calendar_id: '42', from: '2020-01-01', to: '2021-06-01', timezone: 'UTC' });
    const events = body.events as unknown[];
    assert.equal(events.length, 500);
    assert.deepEqual(body.truncated_series, ['daily']);
    assert.match(String(body.truncation_note), /500/);
  });

  it('lists an unsupported rule instead of pretending it occurs in the window', async () => {
    const odd = event({
      uuid: 'ordinal-year',
      title: '年の20番目の月曜',
      start_at: Date.parse('2026-01-05T00:00:00.000Z'),
      end_at: Date.parse('2026-01-05T01:00:00.000Z'),
      recurrences: ['RRULE:FREQ=YEARLY;BYDAY=20MO'],
    });
    const tool = createGetEventsTool(client([odd]));
    const outside = await call(tool, { calendar_id: '42', from: '2026-10-26' });
    assert.deepEqual(outside.body.events, []);
    assert.deepEqual(outside.body.unexpanded_series, [
      {
        uuid: 'ordinal-year',
        title: '年の20番目の月曜',
        recurrences: ['RRULE:FREQ=YEARLY;BYDAY=20MO'],
      },
    ]);

    const onStart = await call(tool, { calendar_id: '42', from: '2026-01-05', timezone: 'UTC' });
    const rows = onStart.body.events as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.recurrence_expanded, false);
    assert.equal(rows[0]!.is_recurring_occurrence, undefined);
    assert.deepEqual(rows[0]!.recurrences, ['RRULE:FREQ=YEARLY;BYDAY=20MO']);
  });

  it('rejects an impossible date or timezone', async () => {
    const tool = createGetEventsTool(client([]));
    const badDate = await call(tool, { calendar_id: '42', from: '2026-02-31' });
    assert.equal(badDate.isError, true);
    assert.equal(badDate.body.error, 'Invalid range');

    const badZone = await call(tool, { calendar_id: '42', from: '2026-10-26', timezone: 'Japan/Tokyo' });
    assert.equal(badZone.isError, true);
    assert.match(String(badZone.body.message), /Asia\/Tokyo/);
  });

  it('still reports an unknown calendar', async () => {
    const failing = {
      async getEventsByCalendar() {
        throw new InvalidCalendarError('missing');
      },
    } as unknown as TimeTreeAPIClient;
    const { body, isError } = await call(createGetEventsTool(failing), { calendar_id: 'nope' });
    assert.equal(isError, true);
    assert.equal(body.error, 'Invalid calendar');
  });

  it('advertises the range parameters on the tool schema', () => {
    const tool = createGetEventsTool(client([]));
    const properties = (tool.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok(properties.from);
    assert.ok(properties.to);
    assert.ok(properties.end_before);
    assert.ok(properties.timezone);
    assert.ok(properties.expand_recurring);
    assert.match(tool.description, /EXDATE/);
    assert.match(tool.description, /2026-10-26/);
  });
});

describe('get_updated_events recurrence output', () => {
  it('includes recurrence lines and does not expand the series', async () => {
    const tool = createGetUpdatedEventsTool(client([garbage({ recurring_uuid: null })]));
    const { body } = await call(tool, { calendar_id: '42', updated_after: 0 });
    const events = body.events as Array<Record<string, unknown>>;
    assert.equal(events.length, 1);
    assert.equal(events[0]!.start_at, '2025-06-25T22:30:00.000Z');
    assert.equal(events[0]!.has_recurrence, true);
    assert.deepEqual(events[0]!.recurrences, ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH']);
    assert.equal(events[0]!.is_recurring_occurrence, undefined);
    assert.match(tool.description, /not expanded/);
  });
});
