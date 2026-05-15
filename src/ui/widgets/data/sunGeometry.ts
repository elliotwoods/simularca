import SunCalc from "suncalc";
import { WORLD_MAP_HEIGHT, WORLD_MAP_WIDTH } from "@/ui/widgets/data/worldMapPaths";

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/**
 * Equirectangular projection used by the bundled world map.
 * x ∈ [0, WORLD_MAP_WIDTH] = lng + 180
 * y ∈ [0, WORLD_MAP_HEIGHT] = 90 - lat
 */
export function projectLngLat(lng: number, lat: number): { x: number; y: number } {
  return {
    x: ((lng + 180) / 360) * WORLD_MAP_WIDTH,
    y: ((90 - lat) / 180) * WORLD_MAP_HEIGHT
  };
}

export function unprojectXY(x: number, y: number): { lat: number; lng: number } {
  const lng = (x / WORLD_MAP_WIDTH) * 360 - 180;
  const lat = 90 - (y / WORLD_MAP_HEIGHT) * 180;
  return {
    lat: Math.max(-90, Math.min(90, lat)),
    lng: ((lng + 540) % 360) - 180
  };
}

/**
 * Subsolar point: where the sun is directly overhead at the given instant.
 * Computed from solar declination + the time-of-day longitude offset.
 */
export function computeSubsolarPoint(utcDate: Date): { lat: number; lng: number } {
  // Solar declination via SunCalc — getPosition at lat=0 lng=0 gives us altitude+azimuth,
  // and azimuth at lat=0 lng=0 reflects the subsolar longitude offset relative to noon UTC.
  // Use a direct computation: the subsolar point is where altitude is highest. We derive it
  // analytically from SunCalc by sampling at a fixed longitude.
  // Simpler: declination = altitude when at subsolar longitude. Approximate:
  //   declination ≈ altitude at lat=0 at the moment of solar noon at lng=0.
  // SunCalc provides getPosition(date, lat, lng); we can derive declination from any
  // (date, lat) by looking at altitude at the meridian where azimuth=0/π.
  // For visualisation it suffices to use the standard astronomical formula.

  const utcHours = utcDate.getUTCHours() + utcDate.getUTCMinutes() / 60 + utcDate.getUTCSeconds() / 3600;
  const dayOfYear = getDayOfYear(utcDate);

  // Solar declination (degrees). NOAA approximation accurate to ~0.4°.
  const fractionalYear =
    ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const declRad =
    0.006918 -
    0.399912 * Math.cos(fractionalYear) +
    0.070257 * Math.sin(fractionalYear) -
    0.006758 * Math.cos(2 * fractionalYear) +
    0.000907 * Math.sin(2 * fractionalYear) -
    0.002697 * Math.cos(3 * fractionalYear) +
    0.00148 * Math.sin(3 * fractionalYear);
  const declDeg = declRad * RAD;

  // Equation of time (minutes).
  const eotMin =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(fractionalYear) -
      0.032077 * Math.sin(fractionalYear) -
      0.014615 * Math.cos(2 * fractionalYear) -
      0.040849 * Math.sin(2 * fractionalYear));

  // Subsolar longitude: where local apparent solar noon occurs at this instant.
  //   solar_noon_utc_minutes = 720 - eot_min - longitude * 4
  // → longitude = (720 - eot_min - utc_minutes) / 4
  const utcMinutes = utcHours * 60;
  let subsolarLng = (720 - eotMin - utcMinutes) / 4;
  subsolarLng = ((subsolarLng + 540) % 360) - 180;

  return { lat: declDeg, lng: subsolarLng };
}

/**
 * SVG path-d covering the night region of the world map (equirectangular projection).
 * Returns an empty string at the equinoxes when declination is ~0 (avoids degenerate path).
 */
export function buildNightRegionPath(utcDate: Date, samples = 361): string {
  const sub = computeSubsolarPoint(utcDate);
  const subLatRad = sub.lat * DEG;

  // Terminator latitude as a function of longitude:
  //   tan(termLat) = -cos(lng - subLng) / tan(subLat)
  // Special-case near zero declination: terminator is the great circle through both poles
  // along longitudes (subLng + 90°) and (subLng - 90°).

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < samples; i += 1) {
    const lng = -180 + (i / (samples - 1)) * 360;
    let termLat: number;
    if (Math.abs(subLatRad) < 1e-4) {
      termLat = 0;
    } else {
      termLat = Math.atan(-Math.cos((lng - sub.lng) * DEG) / Math.tan(subLatRad)) * RAD;
    }
    const projected = projectLngLat(lng, termLat);
    points.push(projected);
  }

  // Determine which side is night: at the antipode of the subsolar point the sun is below
  // horizon. So the night region is on the side of the terminator that contains the antipode.
  const antipode = { lat: -sub.lat, lng: ((sub.lng + 360) % 360) - 180 };
  const antiProj = projectLngLat(antipode.lng, antipode.lat);
  // Test: is the antipode above (north of) the terminator at its longitude?
  let nightAbove: boolean;
  if (Math.abs(subLatRad) < 1e-4) {
    // At equinox: terminator is the equator → night is the half farther from sun. Use lng comparison.
    nightAbove = false;
  } else {
    const sampleAtAntipodeLng = (() => {
      const lng = antipode.lng;
      const termLat = Math.atan(-Math.cos((lng - sub.lng) * DEG) / Math.tan(subLatRad)) * RAD;
      return projectLngLat(lng, termLat).y;
    })();
    nightAbove = antiProj.y < sampleAtAntipodeLng;
  }

  // Build closed path. Start at left edge along terminator, go right, then close along map edge.
  const segments: string[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (!p) continue;
    segments.push(`${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`);
  }
  // Close along the appropriate map edge (top if night is above, bottom otherwise).
  const edgeY = nightAbove ? 0 : WORLD_MAP_HEIGHT;
  segments.push(`L${WORLD_MAP_WIDTH.toFixed(2)},${edgeY.toFixed(2)}`);
  segments.push(`L0,${edgeY.toFixed(2)}`);
  segments.push("Z");
  return segments.join(" ");
}

/** Sun altitude in degrees at (lat, lng) at the given UTC time. */
export function sunAltitudeDeg(utcDate: Date, lat: number, lng: number): number {
  const pos = SunCalc.getPosition(utcDate, lat, lng);
  return pos.altitude * RAD;
}

/** Sample sun altitude every `stepMinutes` between two UTC times. */
export function sampleAltitudeCurve(
  startUtc: Date,
  endUtc: Date,
  lat: number,
  lng: number,
  stepMinutes = 15
): Array<{ tUtc: Date; altitudeDeg: number }> {
  const out: Array<{ tUtc: Date; altitudeDeg: number }> = [];
  const stepMs = stepMinutes * 60 * 1000;
  for (let t = startUtc.getTime(); t <= endUtc.getTime(); t += stepMs) {
    const date = new Date(t);
    out.push({ tUtc: date, altitudeDeg: sunAltitudeDeg(date, lat, lng) });
  }
  return out;
}

/**
 * Sunrise / sunset / solar noon for the local day at `lat, lng`.
 * `referenceUtc` selects the day; SunCalc returns times in UTC.
 * Some polar/edge cases produce NaN dates — caller should check `Number.isFinite(t.getTime())`.
 */
export function getDayTimes(
  referenceUtc: Date,
  lat: number,
  lng: number
): { sunrise: Date; sunset: Date; solarNoon: Date; nadir: Date } {
  const t = SunCalc.getTimes(referenceUtc, lat, lng);
  return {
    sunrise: t.sunrise,
    sunset: t.sunset,
    solarNoon: t.solarNoon,
    nadir: t.nadir
  };
}

function getDayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = date.getTime() - start;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}
