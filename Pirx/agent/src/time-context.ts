export interface CurrentTimeContext {
  readonly instantUtc: string;
  readonly localDate: string;
  readonly localTime: string;
  readonly localDateTime: string;
  readonly timeZone: string;
  readonly utcOffset: string;
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function requiredPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new Error(`Nie można wyznaczyć części czasu: ${type}.`);
  }
  return Number(value);
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function zonedParts(now: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  return {
    year: requiredPart(parts, "year"),
    month: requiredPart(parts, "month"),
    day: requiredPart(parts, "day"),
    hour: requiredPart(parts, "hour"),
    minute: requiredPart(parts, "minute"),
    second: requiredPart(parts, "second"),
  };
}

function utcOffset(now: Date, parts: ZonedParts): string {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const instantWithoutMilliseconds = Math.floor(now.getTime() / 1_000) * 1_000;
  const offsetMinutes = Math.round((localAsUtc - instantWithoutMilliseconds) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteMinutes = Math.abs(offsetMinutes);
  return `${sign}${twoDigits(Math.floor(absoluteMinutes / 60))}:${twoDigits(absoluteMinutes % 60)}`;
}

export function currentTimeContext(now: Date, timeZone: string): CurrentTimeContext {
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Nie można zbudować kontekstu z nieprawidłowej daty.");
  }

  const parts = zonedParts(now, timeZone);
  const localDate = `${parts.year}-${twoDigits(parts.month)}-${twoDigits(parts.day)}`;
  const localTime = `${twoDigits(parts.hour)}:${twoDigits(parts.minute)}:${twoDigits(parts.second)}`;
  const offset = utcOffset(now, parts);

  return {
    instantUtc: now.toISOString(),
    localDate,
    localTime,
    localDateTime: `${localDate}T${localTime}${offset}`,
    timeZone,
    utcOffset: offset,
  };
}

export function currentTimeSystemContext(now: Date, timeZone: string): string {
  const context = currentTimeContext(now, timeZone);
  return [
    "Bieżący kontekst czasu (wygenerowany na nowo dla tego wywołania modelu):",
    `- lokalna data i godzina: ${context.localDateTime}`,
    `- strefa czasowa: ${context.timeZone}`,
    `- chwila UTC: ${context.instantUtc}`,
    'Interpretuj określenia względne, takie jak "dzisiaj", "jutro" i "za godzinę", względem tego kontekstu.',
    "Dla operacji kalendarzowych zamieniaj je na jednoznaczne daty ze strefą lub offsetem.",
  ].join("\n");
}
