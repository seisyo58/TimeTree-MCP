# TimeTree MCP Commands

Quick reference for using TimeTree MCP Server with Claude.

## Available Tools

| Tool | Description | Example Prompts |
|------|-------------|-----------------|
| **list_calendars** | List all active calendars with participating users | • "List my TimeTree calendars"<br>• "Show me all my calendars"<br>• "What calendars do I have?" |
| **get_events** | Get events from a specific calendar | • "Show events from calendar 123456"<br>• "Get my Personal calendar events"<br>• "What's on my schedule?" |

## Parameters

### list_calendars
- **Input**: None
- **Output**: Calendar list with users

### get_events
- **calendar_id** (required): Calendar ID from `list_calendars`
- **start_after** (optional): Unix timestamp (ms), exclusive. Without `end_before` or `from`/`to`, this filters the series' first start and does **not** expand recurrence
- **end_before** (optional): Unix timestamp (ms), exclusive. Expands recurring events into occurrences that start before this time
- **from** / **to** (optional): Inclusive `YYYY-MM-DD` dates. Timezone defaults to `Asia/Tokyo`. If only one is set, the window is that single day. This is the right way to ask "what's on 2026-10-26?"
- **timezone** (optional): IANA timezone for `from`/`to`. Default `Asia/Tokyo`
- **expand_recurring** (optional): Expand series when a range end is set. Default `true`
- **limit** (optional): Maximum number of rows to return, applied after expansion

Every event includes `recurrences` (TimeTree's `RRULE` / `EXDATE` / `RDATE` lines) and `recurring_uuid`. Expanded rows set `is_recurring_occurrence: true` and `series_start_at`, and share the series `uuid`.

`get_updated_events` also returns `recurrences`, but does not expand them.

#### Example: weekly garbage day

「燃やすごみ」 is stored once, starting Thursday 2025-06-26 07:30 JST (`2025-06-25T22:30:00Z`), with `recurrences: ["RRULE:FREQ=WEEKLY;BYDAY=MO,TH"]`.

Ask for Monday 2026-10-26:

```json
{ "calendar_id": "123456", "from": "2026-10-26" }
```

The row comes back at the Monday occurrence, not the original Thursday:

```json
{
  "title": "燃やすごみ",
  "start_at": "2026-10-25T22:30:00.000Z",
  "end_at": "2026-10-25T22:40:00.000Z",
  "start_timezone": "Asia/Tokyo",
  "all_day": false,
  "recurrences": ["RRULE:FREQ=WEEKLY;BYDAY=MO,TH"],
  "has_recurrence": true,
  "is_recurring_occurrence": true,
  "series_start_at": "2025-06-25T22:30:00.000Z"
}
```

`2026-10-25T22:30:00Z` is 07:30 JST on Monday 2026-10-26. The example series lasts 10 minutes, so `end_at` is 10 minutes after the occurrence start. `from: "2026-10-26", to: "2026-10-29"` also includes Thursday 2026-10-29 (`2026-10-28T22:30:00.000Z`). A date-only `EXDATE:20261026` drops that Monday. All-day events stay at UTC midnight (`2026-10-26T00:00:00.000Z` for an all-day Monday). Monthly "2nd and 4th Tuesday" is `RRULE:FREQ=MONTHLY;BYDAY=2TU,4TU`.

## Common Usage Patterns

```
# Basic workflow
"List my calendars" → Get calendar IDs
"Show events from calendar 123456" → View events

# Find events with someone
"What do I have with Sarah?" → Claude finds the calendar with Sarah and shows events

# Filter by date
"Show my events after February 1st from calendar 123456"

# Recurring event on a calendar day (Asia/Tokyo)
"What's on 2026-10-26?" → from "2026-10-26" (includes weekly events whose series started earlier)

# Daily check
"What's on my schedule today?"
```
