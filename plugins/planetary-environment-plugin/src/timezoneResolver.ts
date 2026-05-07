import tzLookup from "tz-lookup";

export interface TimezoneInput {
  mode: "auto" | "manual";
  ianaName?: string;
  latitude: number;
  longitude: number;
}

/**
 * Resolves an IANA timezone name from the input. In auto mode, looks up by lat/lng.
 */
export function resolveTimezone(input: TimezoneInput): string {
  if (input.mode === "manual" && input.ianaName) {
    return input.ianaName;
  }
  try {
    return tzLookup(input.latitude, input.longitude);
  } catch {
    return "UTC";
  }
}

/**
 * Converts a "local datetime in zone" to UTC. The input ISO string is interpreted
 * as wall-clock time in `ianaName`, regardless of any timezone suffix it carries.
 *
 * Approach: use Intl.DateTimeFormat to determine the offset for the given zone at the
 * given instant, then iterate once to correct for DST boundary crossings.
 */
export function localDateInZoneToUtc(localIso: string, ianaName: string): Date {
  // Parse year/month/day/hour/minute/second from the ISO string, treating it as wall time.
  const m = localIso.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    return new Date(localIso);
  }
  const [, y, mo, d, h, mi, s] = m;
  const wallTimeUtcMs = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    s ? Number(s) : 0
  );
  // Offset of `ianaName` from UTC at instant `wallTimeUtcMs`.
  const offsetMs = zoneOffsetMs(new Date(wallTimeUtcMs), ianaName);
  let utcMs = wallTimeUtcMs - offsetMs;
  // Refine once in case the previous offset crossed a DST boundary.
  const refinedOffsetMs = zoneOffsetMs(new Date(utcMs), ianaName);
  if (refinedOffsetMs !== offsetMs) {
    utcMs = wallTimeUtcMs - refinedOffsetMs;
  }
  return new Date(utcMs);
}

/**
 * Returns the zone's offset from UTC in milliseconds at the given instant.
 * Positive for zones east of UTC.
 */
function zoneOffsetMs(at: Date, ianaName: string): number {
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
  if (hour === 24) {
    hour = 0;
  }
  const minute = get("minute");
  const second = get("second");
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - at.getTime();
}
