import SunCalc from "suncalc";

/**
 * Computes the sun direction in scene world space.
 *
 * Scene axis convention:
 *   +Y = up
 *   default South = -Z
 *   default East  = +X
 *
 * SunCalc returns:
 *   altitude: angle above horizon in radians (0 at horizon, pi/2 at zenith)
 *   azimuth : angle from south, clockwise toward west, in radians
 *
 * The user can apply a `northRotationDeg` offset to rotate the whole scene's
 * cardinal axes around the up axis (positive = rotate north clockwise looking down).
 */
export interface SunDirectionInput {
  utcDate: Date;
  latitude: number;
  longitude: number;
  northRotationDeg: number;
}

export interface SunDirectionResult {
  /** Unit vector from origin pointing toward the sun (scene space). */
  direction: [number, number, number];
  /** Sun altitude in degrees above horizon. */
  altitudeDeg: number;
  /** Sun azimuth in degrees from south, clockwise (i.e. west = +90). */
  azimuthDeg: number;
}

export function computeSunDirection(input: SunDirectionInput): SunDirectionResult {
  const pos = SunCalc.getPosition(input.utcDate, input.latitude, input.longitude);
  const altitude = pos.altitude;
  const azimuth = pos.azimuth + degToRad(input.northRotationDeg);
  // SunCalc azimuth: 0 = south, +pi/2 = west.
  // In scene space (south = -Z, east = +X, up = +Y):
  //   - altitude rotates from horizon ring toward +Y
  //   - azimuth rotates around +Y from -Z toward +X is east (-90) and toward -X is west (+90)
  // Horizon point in scene space at azimuth a (from south, west-positive):
  //   x = -sin(a),  z = -cos(a)
  // Then lift by altitude:
  const cosAlt = Math.cos(altitude);
  const x = -Math.sin(azimuth) * cosAlt;
  const z = -Math.cos(azimuth) * cosAlt;
  const y = Math.sin(altitude);
  return {
    direction: [x, y, z],
    altitudeDeg: radToDeg(altitude),
    azimuthDeg: radToDeg(pos.azimuth)
  };
}

function degToRad(d: number): number {
  return (d * Math.PI) / 180;
}

function radToDeg(r: number): number {
  return (r * 180) / Math.PI;
}
