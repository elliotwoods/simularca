/**
 * Thin wrapper around OpenStreetMap Nominatim free geocoding API.
 *
 * ToS: https://operations.osmfoundation.org/policies/nominatim/
 *  - max 1 request per second (debounce in callers)
 *  - identify the application via User-Agent
 *  - no heavy/automated use
 */

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";

export interface GeocodeResult {
  displayName: string;
  lat: number;
  lng: number;
  /** Free-text type from Nominatim (city / town / village / country / ...) */
  type?: string;
}

interface NominatimItem {
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
}

export async function searchPlaces(
  query: string,
  signal?: AbortSignal
): Promise<GeocodeResult[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) {
    return [];
  }
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "8");
  url.searchParams.set("addressdetails", "0");

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Simularca/0.1 (https://github.com/elliotwoods/simularca)"
    },
    signal
  });
  if (!response.ok) {
    throw new Error(`Nominatim request failed: ${response.status}`);
  }
  const items = (await response.json()) as NominatimItem[];
  if (!Array.isArray(items)) {
    return [];
  }
  const results: GeocodeResult[] = [];
  for (const item of items) {
    const lat = typeof item.lat === "string" ? Number(item.lat) : NaN;
    const lng = typeof item.lon === "string" ? Number(item.lon) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const result: GeocodeResult = {
      displayName: item.display_name ?? `${lat.toFixed(3)}, ${lng.toFixed(3)}`,
      lat,
      lng
    };
    if (item.type) {
      result.type = item.type;
    }
    results.push(result);
  }
  return results;
}
