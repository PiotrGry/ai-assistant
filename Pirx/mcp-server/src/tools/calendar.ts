import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import {
  authorizationFailureSchema,
  rejectedAuthorization,
  type SingleUseHostAuthorization,
} from "../authorization.js";

import {
  calendarEventSchema,
  calendarInfoSchema,
  isDateOnly,
  isEventDate,
  isExplicitDateTime,
  isIanaTimeZone,
  type CalendarEventFields,
  type CalendarEventUpdate,
  type CalendarOperations,
  type ListEventsOptions,
} from "../google-calendar/types.js";

const identifierSchema = z.string().trim().min(1).max(1_024);
const calendarIdSchema = identifierSchema.optional();
const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(isIanaTimeZone, "Must be a valid IANA timezone");
const eventDateSchema = z
  .string()
  .trim()
  .refine(
    isEventDate,
    "Must be YYYY-MM-DD or an ISO 8601 timestamp with an explicit Z/UTC offset",
  );
const rangeDateTimeSchema = z
  .string()
  .trim()
  .refine(
    isExplicitDateTime,
    "Must be an ISO 8601 timestamp with an explicit Z/UTC offset",
  );
const attendeesSchema = z.array(z.string().trim().email()).max(100);

function validateEventRange(
  value: { readonly start: string; readonly end: string },
  context: z.core.$RefinementCtx,
): void {
  const allDay = isDateOnly(value.start) && isDateOnly(value.end);
  const timed = isExplicitDateTime(value.start) && isExplicitDateTime(value.end);
  if (!allDay && !timed) {
    context.addIssue({
      code: "custom",
      message: "start and end must use the same timed or all-day representation",
      path: ["end"],
      input: value,
    });
    return;
  }
  const ordered = allDay
    ? value.end > value.start
    : Date.parse(value.end) > Date.parse(value.start);
  if (!ordered) {
    context.addIssue({
      code: "custom",
      message: "end must be after start",
      path: ["end"],
      input: value.end,
    });
  }
}

const createEventInputSchema = z
  .object({
    calendarId: calendarIdSchema,
    summary: z.string().trim().min(1).max(1_000),
    start: eventDateSchema,
    end: eventDateSchema,
    timeZone: timeZoneSchema.optional(),
    description: z.string().max(20_000).optional(),
    location: z.string().max(2_000).optional(),
    attendees: attendeesSchema.optional(),
  })
  .superRefine(validateEventRange);

const updateEventInputSchema = z
  .object({
    calendarId: calendarIdSchema,
    eventId: identifierSchema,
    summary: z.string().trim().min(1).max(1_000).optional(),
    start: eventDateSchema.optional(),
    end: eventDateSchema.optional(),
    timeZone: timeZoneSchema.optional(),
    description: z.string().max(20_000).optional(),
    location: z.string().max(2_000).optional(),
    attendees: attendeesSchema.optional(),
  })
  .superRefine((value, context) => {
    const fields = [
      value.summary,
      value.start,
      value.end,
      value.description,
      value.location,
      value.attendees,
    ];
    if (fields.every((field) => field === undefined)) {
      context.addIssue({
        code: "custom",
        message: "At least one event field must be supplied",
        input: value,
      });
    }
    if ((value.start === undefined) !== (value.end === undefined)) {
      context.addIssue({
        code: "custom",
        message: "start and end must be updated together",
        path: value.start === undefined ? ["start"] : ["end"],
        input: value,
      });
    } else if (value.start !== undefined && value.end !== undefined) {
      validateEventRange({ start: value.start, end: value.end }, context);
    }
    if (value.timeZone !== undefined && value.start === undefined) {
      context.addIssue({
        code: "custom",
        message: "timeZone can only be changed together with start and end",
        path: ["timeZone"],
        input: value.timeZone,
      });
    }
  });

function structured(result: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

export function registerCalendarTools(
  server: McpServer,
  calendar: CalendarOperations,
  authorization: SingleUseHostAuthorization,
): void {
  server.registerTool(
    "calendar_list_calendars",
    {
      title: "List Google calendars",
      description: "List the calendars currently visible to the authorized Google account.",
      inputSchema: z.object({}),
      outputSchema: z.object({ calendars: z.array(calendarInfoSchema) }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => structured({ calendars: await calendar.listCalendars() }),
  );

  server.registerTool(
    "calendar_list_events",
    {
      title: "List Google Calendar events",
      description:
        "Read one page of Google Calendar events in chronological order. If complete=false, call again with nextPageToken as pageToken and the same calendar/range to read the remaining events. Never describe a partial page as the whole calendar.",
      inputSchema: z
        .object({
          calendarId: calendarIdSchema,
          timeMin: rangeDateTimeSchema.optional(),
          timeMax: rangeDateTimeSchema.optional(),
          maxResults: z.number().int().min(1).max(250).optional(),
          pageToken: z.string().min(1).max(4096).optional(),
        })
        .superRefine((value, context) => {
          if (
            value.timeMin !== undefined &&
            value.timeMax !== undefined &&
            Date.parse(value.timeMax) <= Date.parse(value.timeMin)
          ) {
            context.addIssue({
              code: "custom",
              message: "timeMax must be after timeMin",
              path: ["timeMax"],
              input: value.timeMax,
            });
          }
        }),
      outputSchema: z.object({ events: z.array(calendarEventSchema), complete: z.boolean(), nextPageToken: z.string().optional() }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ calendarId, timeMin, timeMax, maxResults, pageToken }) => {
      const options: ListEventsOptions = {
        ...(calendarId !== undefined ? { calendarId } : {}),
        ...(timeMin !== undefined ? { timeMin } : {}),
        ...(timeMax !== undefined ? { timeMax } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
        ...(pageToken !== undefined ? { pageToken } : {}),
      };
      return structured({ ...await calendar.listEvents(options) });
    },
  );

  server.registerTool(
    "calendar_get_event",
    {
      title: "Get a Google Calendar event",
      description:
        "Read one current Google Calendar event by its explicit event ID. Use this to verify the event's current external state.",
      inputSchema: z.object({
        calendarId: calendarIdSchema,
        eventId: identifierSchema,
      }),
      outputSchema: z.object({ event: calendarEventSchema }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ calendarId, eventId }) =>
      structured({ event: await calendar.getEvent(calendarId, eventId) }),
  );

  server.registerTool(
    "calendar_create_event",
    {
      title: "Create a Google Calendar event",
      description:
        "Create exactly one event. Timed values require explicit offsets; YYYY-MM-DD pairs create all-day events whose end date is exclusive.",
      inputSchema: createEventInputSchema,
      outputSchema: z.union([z.object({ event: calendarEventSchema }), authorizationFailureSchema]),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      const decision = authorization.consume(context.mcpReq._meta, "calendar_create_event", input);
      if (!decision.ok) return rejectedAuthorization(decision.failure);
      const { calendarId, summary, start, end, timeZone, description, location, attendees } = input;
      const event: CalendarEventFields = {
        summary,
        start,
        end,
        ...(timeZone !== undefined ? { timeZone } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(attendees !== undefined ? { attendees } : {}),
      };
      return structured({ event: await calendar.createEvent(calendarId, event) });
    },
  );

  server.registerTool(
    "calendar_update_event",
    {
      title: "Update a Google Calendar event",
      description:
        "Patch exactly one event by ID. Only supplied fields are changed; omitted fields are preserved.",
      inputSchema: updateEventInputSchema,
      outputSchema: z.union([z.object({ event: calendarEventSchema }), authorizationFailureSchema]),
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      const decision = authorization.consume(context.mcpReq._meta, "calendar_update_event", input);
      if (!decision.ok) return rejectedAuthorization(decision.failure);
      const { calendarId, eventId, summary, start, end, timeZone, description, location, attendees } = input;
      const update: CalendarEventUpdate = {
        ...(summary !== undefined ? { summary } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
        ...(timeZone !== undefined ? { timeZone } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(attendees !== undefined ? { attendees } : {}),
      };
      return structured({ event: await calendar.updateEvent(calendarId, eventId, update) });
    },
  );

  server.registerTool(
    "calendar_delete_event",
    {
      title: "Delete a Google Calendar event",
      description: "Delete exactly one Google Calendar event by its explicit event ID.",
      inputSchema: z.object({
        calendarId: calendarIdSchema,
        eventId: identifierSchema,
      }),
      outputSchema: z.union([z.object({ eventId: z.string(), deleted: z.literal(true) }), authorizationFailureSchema]),
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    async (input, context) => {
      const decision = authorization.consume(context.mcpReq._meta, "calendar_delete_event", input);
      if (!decision.ok) return rejectedAuthorization(decision.failure);
      const { calendarId, eventId } = input;
      await calendar.deleteEvent(calendarId, eventId);
      return structured({ eventId, deleted: true });
    },
  );
}
