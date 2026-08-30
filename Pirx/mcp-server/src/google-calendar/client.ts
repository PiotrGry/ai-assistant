import type { GoogleCalendarConfig } from "../config.js";
import type { AccessTokenProvider, FetchLike } from "./auth.js";
import {
  CalendarError,
  eventTiming,
  googleCalendarListSchema,
  googleEventResourceSchema,
  googleEventsListSchema,
  isExplicitDateTime,
  type CalendarEvent,
  type CalendarEventFields,
  type CalendarEventUpdate,
  type CalendarInfo,
  type CalendarOperations,
  type GoogleEventDateTime,
  type ListEventsOptions,
} from "./types.js";

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const MAX_CALENDAR_PAGES = 20;

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function conciseGoogleError(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || !("error" in raw)) {
    return undefined;
  }
  const error = raw.error;
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return undefined;
  }
  return typeof error.message === "string" ? error.message.slice(0, 300) : undefined;
}

function httpError(status: number, raw: unknown): CalendarError {
  const suffix = conciseGoogleError(raw);
  const detail = suffix === undefined ? "" : ` ${suffix}`;
  if (status === 401) {
    return new CalendarError(
      "authentication",
      `Google Calendar authorization failed (HTTP 401). Reauthorize the account.${detail}`,
      { status },
    );
  }
  if (status === 403) {
    return new CalendarError(
      "forbidden",
      `Google Calendar denied this operation (HTTP 403).${detail}`,
      { status },
    );
  }
  if (status === 404) {
    return new CalendarError(
      "not_found",
      `Google Calendar resource was not found (HTTP 404).${detail}`,
      { status },
    );
  }
  if (status === 429) {
    return new CalendarError(
      "rate_limited",
      `Google Calendar rate limit was reached (HTTP 429).${detail}`,
      { status },
    );
  }
  if (status >= 500) {
    return new CalendarError(
      "unavailable",
      `Google Calendar is temporarily unavailable (HTTP ${status}).${detail}`,
      { status },
    );
  }
  return new CalendarError(
    "invalid_request",
    `Google Calendar rejected the request (HTTP ${status}).${detail}`,
    { status },
  );
}

function eventEndpoint(calendarId: string, eventId?: string): string {
  const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
  return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
}

function eventValue(value: GoogleEventDateTime): string {
  const result = value.dateTime ?? value.date;
  if (result === undefined) {
    throw new CalendarError(
      "malformed_response",
      "Google Calendar event did not include a valid start or end.",
    );
  }
  return result;
}

function calendarEvent(raw: unknown): CalendarEvent {
  const parsed = googleEventResourceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CalendarError(
      "malformed_response",
      "Google Calendar returned a malformed event response.",
    );
  }
  const event = parsed.data;
  const start = eventValue(event.start);
  const end = eventValue(event.end);
  const attendees = event.attendees
    ?.map((attendee) => attendee.email)
    .filter((email): email is string => email !== undefined);

  return {
    id: event.id,
    summary: (event.summary ?? "(untitled)").slice(0, 1_000),
    start,
    end,
    allDay: event.start.date !== undefined,
    ...(event.start.timeZone !== undefined ? { timeZone: event.start.timeZone } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.description !== undefined
      ? { description: event.description.slice(0, 4_000) }
      : {}),
    ...(event.location !== undefined ? { location: event.location.slice(0, 1_000) } : {}),
    ...(attendees !== undefined && attendees.length > 0
      ? { attendees: attendees.slice(0, 100) }
      : {}),
    ...(event.htmlLink !== undefined ? { htmlLink: event.htmlLink } : {}),
  };
}

function eventSortValue(event: CalendarEvent): number {
  return event.allDay
    ? Date.parse(`${event.start}T00:00:00Z`)
    : Date.parse(event.start);
}

function eventRequestBody(
  event: CalendarEventFields,
  defaultTimeZone: string,
): Record<string, unknown> {
  const timing = eventTiming(
    event.start,
    event.end,
    event.timeZone ?? defaultTimeZone,
  );
  return {
    summary: event.summary,
    start: timing.start,
    end: timing.end,
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.location !== undefined ? { location: event.location } : {}),
    ...(event.attendees !== undefined
      ? { attendees: event.attendees.map((email) => ({ email })) }
      : {}),
  };
}

export class GoogleCalendarClient implements CalendarOperations {
  readonly #tokenProvider: AccessTokenProvider;
  readonly #config: GoogleCalendarConfig;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(
    tokenProvider: AccessTokenProvider,
    config: GoogleCalendarConfig,
    options: { readonly fetch?: FetchLike; readonly baseUrl?: string } = {},
  ) {
    this.#tokenProvider = tokenProvider;
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? GOOGLE_CALENDAR_BASE_URL).replace(/\/+$/u, "");
  }

  async #request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    query: URLSearchParams = new URLSearchParams(),
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const token = await this.#tokenProvider.getAccessToken();
    const url = new URL(`${this.#baseUrl}${path}`);
    url.search = query.toString();

    const signal = AbortSignal.timeout(this.#config.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error: unknown) {
      if (isTimeout(error)) {
        throw new CalendarError("timeout", "Google Calendar request timed out.", {
          cause: error,
        });
      }
      throw new CalendarError("network", "Google Calendar network request failed.", {
        cause: error,
      });
    }

    if (response.status === 204) {
      return undefined;
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error: unknown) {
      if (isTimeout(error) || signal.aborted) {
        throw new CalendarError("timeout", "Google Calendar response timed out.", {
          cause: error,
        });
      }
      throw new CalendarError("network", "Could not read the Google Calendar response.", {
        cause: error,
      });
    }
    let raw: unknown;
    try {
      raw = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch (error: unknown) {
      throw new CalendarError(
        "malformed_response",
        `Google Calendar returned malformed JSON (HTTP ${response.status}).`,
        { cause: error, status: response.status },
      );
    }
    if (!response.ok) {
      throw httpError(response.status, raw);
    }
    if (raw === undefined) {
      throw new CalendarError(
        "malformed_response",
        "Google Calendar returned an empty response.",
        { status: response.status },
      );
    }
    return raw;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const calendars: CalendarInfo[] = [];
    let pageToken: string | undefined;
    const seenTokens = new Set<string>();

    for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
      const query = new URLSearchParams({ maxResults: "250" });
      if (pageToken !== undefined) {
        query.set("pageToken", pageToken);
      }
      const parsed = googleCalendarListSchema.safeParse(
        await this.#request("GET", "/users/me/calendarList", query),
      );
      if (!parsed.success) {
        throw new CalendarError(
          "malformed_response",
          "Google Calendar returned a malformed calendar list.",
        );
      }
      for (const calendar of parsed.data.items ?? []) {
        calendars.push({
          id: calendar.id,
          summary: calendar.summary ?? calendar.id,
          ...(calendar.primary !== undefined ? { primary: calendar.primary } : {}),
          ...(calendar.timeZone !== undefined ? { timeZone: calendar.timeZone } : {}),
          ...(calendar.accessRole !== undefined ? { accessRole: calendar.accessRole } : {}),
        });
      }
      pageToken = parsed.data.nextPageToken;
      if (pageToken === undefined) {
        return calendars;
      }
      if (seenTokens.has(pageToken)) {
        throw new CalendarError(
          "malformed_response",
          "Google Calendar repeated a calendar-list page token.",
        );
      }
      seenTokens.add(pageToken);
    }

    throw new CalendarError(
      "malformed_response",
      `Google Calendar list exceeded ${MAX_CALENDAR_PAGES} pages.`,
    );
  }

  async listEvents(options: ListEventsOptions): Promise<CalendarEvent[]> {
    if (
      options.maxResults !== undefined &&
      (!Number.isSafeInteger(options.maxResults) ||
        options.maxResults < 1 ||
        options.maxResults > 250)
    ) {
      throw new CalendarError("invalid_request", "maxResults must be an integer from 1 to 250.");
    }
    if (options.timeMin !== undefined && !isExplicitDateTime(options.timeMin)) {
      throw new CalendarError("invalid_request", "timeMin must be an ISO 8601 timestamp with an explicit offset.");
    }
    if (options.timeMax !== undefined && !isExplicitDateTime(options.timeMax)) {
      throw new CalendarError("invalid_request", "timeMax must be an ISO 8601 timestamp with an explicit offset.");
    }
    if (
      options.timeMin !== undefined &&
      options.timeMax !== undefined &&
      Date.parse(options.timeMax) <= Date.parse(options.timeMin)
    ) {
      throw new CalendarError("invalid_request", "timeMax must be after timeMin.");
    }

    const calendarId = options.calendarId ?? this.#config.defaultCalendarId;
    const query = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(options.maxResults ?? 50),
      timeZone: this.#config.defaultTimeZone,
    });
    if (options.timeMin !== undefined) {
      query.set("timeMin", options.timeMin);
    }
    if (options.timeMax !== undefined) {
      query.set("timeMax", options.timeMax);
    }

    const parsed = googleEventsListSchema.safeParse(
      await this.#request("GET", eventEndpoint(calendarId), query),
    );
    if (!parsed.success) {
      throw new CalendarError(
        "malformed_response",
        "Google Calendar returned a malformed event list.",
      );
    }
    return (parsed.data.items ?? [])
      .map((event) => calendarEvent(event))
      .sort((left, right) => eventSortValue(left) - eventSortValue(right));
  }

  async getEvent(
    calendarId: string | undefined,
    eventId: string,
  ): Promise<CalendarEvent> {
    const id = calendarId ?? this.#config.defaultCalendarId;
    return calendarEvent(await this.#request("GET", eventEndpoint(id, eventId)));
  }

  async createEvent(
    calendarId: string | undefined,
    event: CalendarEventFields,
  ): Promise<CalendarEvent> {
    const id = calendarId ?? this.#config.defaultCalendarId;
    return calendarEvent(
      await this.#request(
        "POST",
        eventEndpoint(id),
        new URLSearchParams(),
        eventRequestBody(event, this.#config.defaultTimeZone),
      ),
    );
  }

  async updateEvent(
    calendarId: string | undefined,
    eventId: string,
    update: CalendarEventUpdate,
  ): Promise<CalendarEvent> {
    const id = calendarId ?? this.#config.defaultCalendarId;
    const body: Record<string, unknown> = {
      ...(update.summary !== undefined ? { summary: update.summary } : {}),
      ...(update.description !== undefined ? { description: update.description } : {}),
      ...(update.location !== undefined ? { location: update.location } : {}),
      ...(update.attendees !== undefined
        ? { attendees: update.attendees.map((email) => ({ email })) }
        : {}),
    };
    if (update.start !== undefined && update.end !== undefined) {
      const timing = eventTiming(
        update.start,
        update.end,
        update.timeZone ?? this.#config.defaultTimeZone,
      );
      body["start"] = timing.start;
      body["end"] = timing.end;
    }

    return calendarEvent(
      await this.#request(
        "PATCH",
        eventEndpoint(id, eventId),
        new URLSearchParams(),
        body,
      ),
    );
  }

  async deleteEvent(calendarId: string | undefined, eventId: string): Promise<void> {
    const id = calendarId ?? this.#config.defaultCalendarId;
    await this.#request("DELETE", eventEndpoint(id, eventId));
  }
}
