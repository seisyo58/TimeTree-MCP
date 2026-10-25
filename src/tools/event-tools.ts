/**
 * Event Tools for MCP
 * Provides event querying functionality with automatic pagination.
 *
 * Recurrence: TimeTree returns one row per series. `recurrences` holds RRULE /
 * EXDATE / RDATE lines. get_events expands those into occurrences only when the
 * caller sets a range end (`from`/`to` or `end_before`). start_after alone keeps
 * the previous filter-on-series-start behavior.
 */

import { z } from 'zod';
import type { TimeTreeAPIClient } from '../client/api.js';
import { InvalidCalendarError } from '../client/api.js';
import { logger } from '../utils/logger.js';
import { getLabelColorName } from '../types/label-colors.js';
import type { Event } from '../types/timetree.js';
import { stringRecurrences } from '../utils/recurrence.js';
import {
  DEFAULT_RANGE_TIMEZONE,
  InvalidRangeError,
  MAX_OCCURRENCES_PER_SERIES,
  selectEventRows,
  type EventRow,
} from '../utils/event-range.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const GetEventsInputSchema = z.object({
  calendar_id: z.string().describe('The calendar ID to fetch events from'),
  start_after: z
    .number()
    .optional()
    .describe(
      'Optional Unix timestamp in milliseconds. Only return events starting after this time. ' +
        'On its own this does not expand recurrence; a series is kept only when its first start is after this time.'
    ),
  end_before: z
    .number()
    .optional()
    .describe(
      'Optional Unix timestamp in milliseconds, exclusive. Expands recurring events into occurrences ' +
        'that start before this time. Prefer from/to for a calendar day in Asia/Tokyo.'
    ),
  from: z
    .string()
    .regex(DATE_ONLY)
    .optional()
    .describe(
      'Inclusive calendar date (YYYY-MM-DD) in `timezone` (default Asia/Tokyo). ' +
        'Expands recurring events into occurrences on that day. If `to` is omitted, only this day is returned.'
    ),
  to: z
    .string()
    .regex(DATE_ONLY)
    .optional()
    .describe(
      'Inclusive calendar date (YYYY-MM-DD) in `timezone` (default Asia/Tokyo). Defaults to `from` when omitted.'
    ),
  timezone: z
    .string()
    .optional()
    .describe(
      'IANA timezone used to interpret `from`/`to` for timed events. Defaults to Asia/Tokyo. ' +
        'All-day events match the UTC calendar date of from/to instead of that local window.'
    ),
  expand_recurring: z
    .boolean()
    .optional()
    .describe(
      'When from/to or end_before is set, expand each series into occurrences in the window. Defaults to true. ' +
        'Set false to filter on the series start only.'
    ),
  limit: z
    .number()
    .optional()
    .describe('Optional limit on number of events to return. Defaults to all events.'),
});

export const GetUpdatedEventsInputSchema = z.object({
  calendar_id: z.string().describe('The calendar ID to fetch updated events from'),
  updated_after: z
    .number()
    .describe('Unix timestamp in milliseconds. Only return events updated after this time.'),
  limit: z
    .number()
    .optional()
    .describe('Optional limit on number of events to return. Defaults to all events.'),
});

function formatListedEvent(row: EventRow) {
  const { event, startAt, endAt, occurrence } = row;
  return {
    uuid: event.uuid,
    title: event.title,
    start_at: new Date(startAt).toISOString(),
    start_timezone: event.start_timezone || null,
    end_at: new Date(endAt).toISOString(),
    end_timezone: event.end_timezone || null,
    all_day: event.all_day,
    label_id: event.label_id || null,
    label_color: event.label_id ? getLabelColorName(event.label_id) : null,
    location: event.location || null,
    location_lat: event.location_lat || null,
    location_lon: event.location_lon || null,
    note: event.note || null,
    url: event.url || null,
    category: event.category || null,
    type: event.type || null,
    created_at: event.created_at ? new Date(event.created_at).toISOString() : null,
    updated_at: event.updated_at ? new Date(event.updated_at).toISOString() : null,
    has_alerts: Boolean(event.alerts && event.alerts.length > 0),
    has_recurrence: Boolean(event.recurrences && event.recurrences.length > 0),
    recurrences: stringRecurrences(event.recurrences),
    recurring_uuid: event.recurring_uuid ?? null,
    checklist: event.attachment?.checklist || null,
    ...(occurrence
      ? {
          is_recurring_occurrence: true,
          series_start_at: new Date(event.start_at).toISOString(),
        }
      : {}),
    ...(row.recurrenceExpanded === false ? { recurrence_expanded: false } : {}),
  };
}

function invalidCalendarResult() {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: 'Invalid calendar',
            message: `Calendar not found. Please use list_calendars to get valid calendar IDs.`,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function zodErrorResult(message: string, error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: 'Invalid input',
            message,
            details: (error as { errors?: unknown }).errors,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

function failureResult(errorName: string, error: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            error: errorName,
            message: (error as Error).message,
          },
          null,
          2
        ),
      },
    ],
    isError: true,
  };
}

export function createGetEventsTool(apiClient: TimeTreeAPIClient) {
  return {
    name: 'get_events',
    description:
      'Get events from a TimeTree calendar. TimeTree stores a repeating event once: `recurrences` is an array of ' +
      'iCalendar lines such as "RRULE:FREQ=WEEKLY;BYDAY=MO,TH" and "EXDATE:20261026" (a deleted occurrence). ' +
      'Those lines are always returned. Without from/to or end_before, each series is one row at its first start_at ' +
      '(start_after filters that first start only). ' +
      'Pass from and to as YYYY-MM-DD dates (timezone defaults to Asia/Tokyo; a single from is that one day) ' +
      'or end_before (Unix ms, exclusive) to expand each series into the occurrences in the window. ' +
      'EXDATE and comma-separated exception lists are skipped. Timed events repeat at the same local time in ' +
      'start_timezone. All-day events are stored at UTC midnight and match the UTC calendar date of from/to, ' +
      'so a timezone west of UTC does not move them onto the previous local day. ' +
      'Example: 燃やすごみ every Mon/Thu at 07:30 Asia/Tokyo, series start 2025-06-25T22:30:00Z, ' +
      'from "2026-10-26" to "2026-10-26" returns the Monday occurrence at 2026-10-25T22:30:00Z. ' +
      'Occurrences share the series uuid. Each series is capped at ' +
      `${MAX_OCCURRENCES_PER_SERIES} occurrences per call.`,
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'The calendar ID to fetch events from',
        },
        start_after: {
          type: 'number',
          description:
            'Optional Unix timestamp in milliseconds. Only return rows starting after this time. ' +
            'Does not expand recurrence by itself: a series is included only when its first start_at is after this time. ' +
            'Combine with end_before, or use from/to, to include later occurrences. ' +
            'If user provides a date like "2026-02-01", convert it to Unix timestamp (e.g., 1769904000000).',
        },
        end_before: {
          type: 'number',
          description:
            'Optional Unix timestamp in milliseconds, exclusive. Expands recurring events into occurrences that start ' +
            'before this instant. For "what is on YYYY-MM-DD" in Japan, prefer from/to: a 07:30 Asia/Tokyo event falls ' +
            'on the previous UTC date, so a UTC-midnight window misses it.',
        },
        from: {
          type: 'string',
          description:
            'Inclusive calendar date YYYY-MM-DD, interpreted in `timezone` (default Asia/Tokyo). ' +
            'Expands recurring events onto the dates they actually occur. ' +
            'If `to` is omitted, the window is this single day. ' +
            'Example: "2026-10-26" includes 2026-10-26 00:00–24:00 Asia/Tokyo ' +
            '(2026-10-25T15:00:00Z inclusive through 2026-10-26T15:00:00Z exclusive).',
        },
        to: {
          type: 'string',
          description:
            'Inclusive calendar date YYYY-MM-DD in `timezone` (default Asia/Tokyo). ' +
            'Defaults to `from` when only one of them is set.',
        },
        timezone: {
          type: 'string',
          description:
            `IANA timezone for from/to. Defaults to ${DEFAULT_RANGE_TIMEZONE}. ` +
            'Does not override an event\'s start_timezone. All-day events match the UTC calendar date of from/to ' +
            '(2026-10-26T00:00:00Z for "2026-10-26"), including when timezone is west of UTC.',
        },
        expand_recurring: {
          type: 'boolean',
          description:
            'When from/to or end_before is set, return each occurrence in the window instead of only the series start. ' +
            'Defaults to true. Set false to keep one row per series.',
        },
        limit: {
          type: 'number',
          description: 'Optional limit on number of events to return. Applied after expansion and sorting.',
        },
      },
      required: ['calendar_id'],
    },
    handler: async (args: unknown) => {
      try {
        const input = GetEventsInputSchema.parse(args);
        const { calendar_id, start_after, end_before, from, to, timezone, expand_recurring, limit } = input;

        logger.info('Tool: get_events called', {
          calendar_id,
          start_after,
          end_before,
          from,
          to,
          timezone,
          expand_recurring,
          limit,
        });

        const events = await apiClient.getEventsByCalendar(calendar_id, 0);
        const selection = selectEventRows(events, {
          startAfter: start_after,
          endBefore: end_before,
          from,
          to,
          timezone,
          expandRecurring: expand_recurring,
        });

        let rows = selection.rows;
        if (limit) {
          rows = rows.slice(0, limit);
        }

        const formattedEvents = rows.map((row) => formatListedEvent(row));

        const result = {
          calendar_id,
          events: formattedEvents,
          total: formattedEvents.length,
          total_fetched: events.length,
          expanded_recurring: selection.expanded,
          ...(selection.range ? { range: selection.range } : {}),
          ...(selection.truncatedSeries.length
            ? {
                truncated_series: selection.truncatedSeries,
                truncation_note:
                  `Each recurring series is limited to ${MAX_OCCURRENCES_PER_SERIES} occurrences in one response. ` +
                  'Narrow from/to or start_after/end_before to see the rest.',
              }
            : {}),
          ...(selection.unexpandedSeries.length
            ? {
                unexpanded_series: selection.unexpandedSeries,
                unexpanded_note:
                  'These series use a recurrence this server does not expand (for example a year-ordinal BYDAY). ' +
                  'Their original start is outside the requested window, so they are listed here with their recurrences instead of being dropped silently.',
              }
            : {}),
        };

        logger.info('Tool: get_events completed', {
          calendar_id,
          total: result.total,
          expanded_recurring: selection.expanded,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Tool: get_events failed', { error });

        if (error instanceof InvalidRangeError) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    error: 'Invalid range',
                    message: error.message,
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        // Handle specific error types
        if (error instanceof InvalidCalendarError) {
          return invalidCalendarResult();
        }

        if ((error as { name?: string }).name === 'ZodError') {
          return zodErrorResult('Please provide a valid calendar_id (string)', error);
        }

        return failureResult('Failed to fetch events', error);
      }
    },
  };
}

export function createGetUpdatedEventsTool(apiClient: TimeTreeAPIClient) {
  return {
    name: 'get_updated_events',
    description:
      'Get events from a specific TimeTree calendar that were updated after a specified time. ' +
      'Useful for finding recently modified events. Returns event details including title, start/end times, ' +
      'location, notes, label color, and recurrence lines (RRULE / EXDATE / RDATE). ' +
      'Recurring events are returned once, at the series start, and are not expanded into occurrences; ' +
      'use get_events with from/to or end_before to see the dates a series falls on. ' +
      'Label colors (label_id 1-10): 1=Emerald green, 2=Modern cyan, 3=Deep sky blue, 4=Pastel brown, ' +
      '5=Midnight black, 6=Apple red, 7=French rose, 8=Coral pink, 9=Bright orange, 10=Soft violet.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: {
          type: 'string',
          description: 'The calendar ID to fetch updated events from',
        },
        updated_after: {
          type: 'number',
          description:
            'Unix timestamp in milliseconds. Only return events updated after this time. ' +
            'If user provides a date like "2026-02-01", convert it to Unix timestamp (e.g., 1769904000000).',
        },
        limit: {
          type: 'number',
          description: 'Optional limit on number of events to return.',
        },
      },
      required: ['calendar_id', 'updated_after'],
    },
    handler: async (args: unknown) => {
      try {
        const input = GetUpdatedEventsInputSchema.parse(args);
        const { calendar_id, updated_after, limit } = input;

        logger.info('Tool: get_updated_events called', { calendar_id, updated_after, limit });

        const events = await apiClient.getUpdatedEvents(calendar_id, updated_after);

        // Limit results if provided
        let filteredEvents: Event[] = events;
        if (limit) {
          filteredEvents = filteredEvents.slice(0, limit);
        }

        const formattedEvents = filteredEvents.map((event) =>
          formatListedEvent({
            event,
            startAt: event.start_at,
            endAt: event.end_at,
            occurrence: false,
          })
        );

        const result = {
          calendar_id,
          updated_after: new Date(updated_after).toISOString(),
          events: formattedEvents,
          total: formattedEvents.length,
          total_fetched: events.length,
        };

        logger.info('Tool: get_updated_events completed', {
          calendar_id,
          total: result.total,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error('Tool: get_updated_events failed', { error });

        // Handle specific error types
        if (error instanceof InvalidCalendarError) {
          return invalidCalendarResult();
        }

        if ((error as { name?: string }).name === 'ZodError') {
          return zodErrorResult(
            'Please provide valid calendar_id (string) and updated_after (number) parameters',
            error
          );
        }

        return failureResult('Failed to fetch updated events', error);
      }
    },
  };
}
