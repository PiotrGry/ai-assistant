import * as z from "zod/v4";

export type CalendarErrorCode =
  | "configuration"
  | "authentication"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "network"
  | "invalid_request"
  | "malformed_response";

export class CalendarError extends Error {
  readonly code: CalendarErrorCode;
  readonly status: number | undefined;

  constructor(
    code: CalendarErrorCode,
    message: string,
    options: ErrorOptions & { readonly status?: number } = {},
  ) {
    super(message, options);
    this.name = "CalendarError";
    this.code = code;
    this.status = options.status;
  }
}

export const calendarInfoSchema = z.object({
  id: z.string(),
  summary: z.string(),
  primary: z.boolean().optional(),
  timeZone: z.string().optional(),
  accessRole: z.string().optional(),
});

export const calendarEventSchema = z.object({
  id: z.string(),
  summary: z.string(),
  start: z.string(),
  end: z.string(),
  allDay: z.boolean(),
  timeZone: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  attendees: z.array(z.string()).optional(),
  htmlLink: z.string().optional(),
});

export interface CalendarInfo extends z.infer<typeof calendarInfoSchema> {}
export interface CalendarEvent extends z.infer<typeof calendarEventSchema> {}

export interface CalendarEventFields {
  readonly summary: string;
  readonly start: string;
  readonly end: string;
  readonly timeZone?: string;
  readonly description?: string;
  readonly location?: string;
  readonly attendees?: readonly string[];
}

export interface CalendarEventUpdate {
  readonly summary?: string;
  readonly start?: string;
  readonly end?: string;
  readonly timeZone?: string;
  readonly description?: string;
  readonly location?: string;
  readonly attendees?: readonly string[];
}

export interface ListEventsOptions {
  readonly calendarId?: string;
  readonly timeMin?: string;
  readonly timeMax?: string;
  readonly maxResults?: number;
}

export interface CalendarOperations {
  listCalendars(): Promise<CalendarInfo[]>;
  listEvents(options: ListEventsOptions): Promise<CalendarEvent[]>;
  getEvent(calendarId: string | undefined, eventId: string): Promise<CalendarEvent>;
  createEvent(
    calendarId: string | undefined,
    event: CalendarEventFields,
  ): Promise<CalendarEvent>;
  updateEvent(
    calendarId: string | undefined,
    eventId: string,
    update: CalendarEventUpdate,
  ): Promise<CalendarEvent>;
  deleteEvent(calendarId: string | undefined, eventId: string): Promise<void>;
}

const dateOnlyExpression = /^\d{4}-\d{2}-\d{2}$/u;
const explicitOffsetExpression = /(?:Z|[+-]\d{2}:\d{2})$/u;

export function isDateOnly(value: string): boolean {
  if (!dateOnlyExpression.test(value)) {
    return false;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isExplicitDateTime(value: string): boolean {
  return (
    value.includes("T") &&
    explicitOffsetExpression.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function isEventDate(value: string): boolean {
  return isDateOnly(value) || isExplicitDateTime(value);
}

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export interface GoogleEventDateTime {
  readonly date?: string | undefined;
  readonly dateTime?: string | undefined;
  readonly timeZone?: string | undefined;
}

export function eventTiming(
  start: string,
  end: string,
  timeZone: string,
): {
  readonly start: GoogleEventDateTime;
  readonly end: GoogleEventDateTime;
  readonly allDay: boolean;
} {
  const allDay = isDateOnly(start) && isDateOnly(end);
  const timed = isExplicitDateTime(start) && isExplicitDateTime(end);

  if (!allDay && !timed) {
    throw new CalendarError(
      "invalid_request",
      "Calendar start and end must both be YYYY-MM-DD all-day dates or ISO 8601 timestamps with an explicit offset.",
    );
  }
  if (!isIanaTimeZone(timeZone)) {
    throw new CalendarError("invalid_request", `Invalid IANA timezone: ${timeZone}`);
  }

  const ordered = allDay ? end > start : Date.parse(end) > Date.parse(start);
  if (!ordered) {
    throw new CalendarError("invalid_request", "Calendar event end must be after start.");
  }

  if (allDay) {
    return { start: { date: start }, end: { date: end }, allDay: true };
  }
  return {
    start: { dateTime: start, timeZone },
    end: { dateTime: end, timeZone },
    allDay: false,
  };
}

export const googleEventDateTimeSchema = z
  .object({
    date: z.string().refine(isDateOnly).optional(),
    dateTime: z.string().refine(isExplicitDateTime).optional(),
    timeZone: z.string().optional(),
  })
  .loose()
  .refine((value) => (value.date === undefined) !== (value.dateTime === undefined));

export const googleEventResourceSchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().optional(),
    status: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    htmlLink: z.string().optional(),
    start: googleEventDateTimeSchema,
    end: googleEventDateTimeSchema,
    attendees: z
      .array(z.object({ email: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

export const googleEventsListSchema = z
  .object({
    items: z.array(googleEventResourceSchema).optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();

export const googleCalendarListEntrySchema = z
  .object({
    id: z.string().min(1),
    summary: z.string().optional(),
    primary: z.boolean().optional(),
    timeZone: z.string().optional(),
    accessRole: z.string().optional(),
  })
  .loose();

export const googleCalendarListSchema = z
  .object({
    items: z.array(googleCalendarListEntrySchema).optional(),
    nextPageToken: z.string().optional(),
  })
  .loose();
