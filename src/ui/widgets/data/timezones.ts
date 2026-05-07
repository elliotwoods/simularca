import tzLookup from "tz-lookup";
import type { TimezoneParameterValue } from "@/core/types";

/**
 * Resolve the IANA timezone for a TimezoneParameterValue at a given location.
 * Auto mode falls back to lat/lng lookup; manual mode returns the user-chosen name.
 * Returns "UTC" when nothing usable is available.
 */
export function resolveIanaName(
  tz: TimezoneParameterValue | null | undefined,
  lat: number,
  lng: number
): string {
  if (tz?.mode === "manual" && tz.ianaName) {
    return tz.ianaName;
  }
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    try {
      return tzLookup(lat, lng);
    } catch {
      // ignore
    }
  }
  return "UTC";
}

/**
 * Returns the zone's offset from UTC in milliseconds at the given instant.
 * Positive for zones east of UTC.
 */
export function zoneOffsetMs(at: Date, ianaName: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaName,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  const minute = get("minute");
  const second = get("second");
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - at.getTime();
}

/**
 * Convert local-wall-clock components in `ianaName` to a UTC Date.
 */
export function localComponentsToUtc(
  components: { year: number; month: number; day: number; hour: number; minute?: number; second?: number },
  ianaName: string
): Date {
  const wallTimeUtcMs = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute ?? 0,
    components.second ?? 0
  );
  const offsetMs = zoneOffsetMs(new Date(wallTimeUtcMs), ianaName);
  let utcMs = wallTimeUtcMs - offsetMs;
  const refined = zoneOffsetMs(new Date(utcMs), ianaName);
  if (refined !== offsetMs) {
    utcMs = wallTimeUtcMs - refined;
  }
  return new Date(utcMs);
}

/**
 * Get the wall-clock components in `ianaName` of a UTC instant.
 */
export function utcToLocalComponents(
  utc: Date,
  ianaName: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaName,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = dtf.formatToParts(utc);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  let hour = get("hour");
  if (hour === 24) hour = 0;
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour,
    minute: get("minute"),
    second: get("second")
  };
}

/** Format a UTC instant as HH:MM in the given zone. */
export function formatLocalHourMinute(utc: Date, ianaName: string): string {
  if (!Number.isFinite(utc.getTime())) {
    return "—";
  }
  const c = utcToLocalComponents(utc, ianaName);
  return `${pad2(c.hour)}:${pad2(c.minute)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Local-day bounds (start and end at midnight) as UTC instants for the day containing `referenceUtc`
 * in `ianaName`. End is exclusive: it is the next local midnight.
 */
export function getLocalDayBoundsUtc(
  referenceUtc: Date,
  ianaName: string
): { startUtc: Date; endUtc: Date } {
  const c = utcToLocalComponents(referenceUtc, ianaName);
  const startUtc = localComponentsToUtc({ year: c.year, month: c.month, day: c.day, hour: 0, minute: 0, second: 0 }, ianaName);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startUtc, endUtc };
}
