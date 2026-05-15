import { useMemo, useRef, useState } from "react";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";
import { getDayTimes, sampleAltitudeCurve } from "@/ui/widgets/data/sunGeometry";
import {
  formatLocalHourMinute,
  getLocalDayBoundsUtc,
  localComponentsToUtc,
  resolveIanaName,
  utcToLocalComponents
} from "@/ui/widgets/data/timezones";
import type { LocationParameterValue, TimezoneParameterValue } from "@/core/types";

interface DateTimeFieldProps {
  label: string;
  description?: string;
  value: string;
  mixed?: boolean;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onChange: (value: string) => void;
  /** When provided, the daylight track renders for this location. */
  siblingLocation?: LocationParameterValue | null;
  /** Optional sibling timezone — auto-resolves from location if absent. */
  siblingTimezone?: TimezoneParameterValue | null;
}

const TRACK_WIDTH = 360;
const TRACK_HEIGHT = 56;
const TRACK_PAD_X = 8;
const TRACK_BASELINE = TRACK_HEIGHT - 14;

function toLocalInputValue(iso: string, ianaName: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  if (ianaName) {
    const c = utcToLocalComponents(date, ianaName);
    return `${c.year.toString().padStart(4, "0")}-${pad2(c.month)}-${pad2(c.day)}T${pad2(c.hour)}:${pad2(c.minute)}`;
  }
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInputValue(local: string, ianaName: string | null): string {
  if (!local) return "";
  const m = local.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})/);
  if (!m) return "";
  if (ianaName) {
    const utc = localComponentsToUtc(
      {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: Number(m[4]),
        minute: Number(m[5])
      },
      ianaName
    );
    return Number.isFinite(utc.getTime()) ? utc.toISOString() : "";
  }
  const date = new Date(local);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

export function DateTimeField(props: DateTimeFieldProps) {
  const ianaName = useMemo(() => {
    const loc = props.siblingLocation;
    if (!loc) return null;
    return resolveIanaName(props.siblingTimezone ?? null, loc.lat, loc.lng);
  }, [props.siblingLocation, props.siblingTimezone]);

  const localValue = toLocalInputValue(props.value, ianaName);

  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={props.disabled}
      resetAlign="start"
    >
      <div className="widget-datetime">
        <div className="widget-datetime-row">
          <input
            type="datetime-local"
            className="widget-text-input"
            value={localValue}
            disabled={props.disabled}
            onChange={(event) => {
              const iso = fromLocalInputValue(event.target.value, ianaName);
              if (iso) {
                props.onChange(iso);
              }
            }}
          />
          <button
            type="button"
            className="widget-button"
            disabled={props.disabled}
            onClick={() => props.onChange(new Date().toISOString())}
          >
            Now
          </button>
        </div>
        {ianaName ? (
          <div className="widget-datetime-tz">{ianaName}</div>
        ) : null}
        {props.siblingLocation && ianaName ? (
          <DaylightTrack
            isoUtc={props.value}
            location={props.siblingLocation}
            ianaName={ianaName}
            disabled={props.disabled}
            onChange={props.onChange}
          />
        ) : null}
      </div>
    </InspectorFieldRow>
  );
}

interface DaylightTrackProps {
  isoUtc: string;
  location: LocationParameterValue;
  ianaName: string;
  disabled?: boolean;
  onChange: (isoUtc: string) => void;
}

function DaylightTrack(props: DaylightTrackProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const utc = useMemo(() => {
    const d = new Date(props.isoUtc);
    return Number.isFinite(d.getTime()) ? d : new Date();
  }, [props.isoUtc]);

  const bounds = useMemo(() => getLocalDayBoundsUtc(utc, props.ianaName), [utc, props.ianaName]);

  const samples = useMemo(
    () => sampleAltitudeCurve(bounds.startUtc, bounds.endUtc, props.location.lat, props.location.lng, 15),
    [bounds.startUtc, bounds.endUtc, props.location.lat, props.location.lng]
  );

  const dayTimes = useMemo(
    () => getDayTimes(bounds.startUtc, props.location.lat, props.location.lng),
    [bounds.startUtc, props.location.lat, props.location.lng]
  );

  const widthInner = TRACK_WIDTH - 2 * TRACK_PAD_X;
  const dayMs = bounds.endUtc.getTime() - bounds.startUtc.getTime();

  const tToX = (t: Date): number => {
    const f = (t.getTime() - bounds.startUtc.getTime()) / dayMs;
    return TRACK_PAD_X + f * widthInner;
  };

  const altToY = (alt: number): number => {
    // Map altitude [-30°, +90°] to [TRACK_BASELINE, 4]
    const clamped = Math.max(-30, Math.min(90, alt));
    const f = (clamped + 30) / 120;
    return TRACK_BASELINE - f * (TRACK_BASELINE - 4);
  };

  // Build the altitude curve path
  const curveD = useMemo(() => {
    if (samples.length === 0) return "";
    return samples
      .map((s, i) => {
        const x = tToX(s.tUtc);
        const y = altToY(s.altitudeDeg);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [samples, bounds.startUtc, dayMs]);

  // Filled day region: under the curve where altitude > 0
  const dayFillD = useMemo(() => {
    if (samples.length === 0) return "";
    const segments: string[] = [];
    let inDay = false;
    let firstX = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      if (!s) continue;
      const above = s.altitudeDeg > 0;
      const x = tToX(s.tUtc);
      const y = altToY(s.altitudeDeg);
      if (above && !inDay) {
        // start a new day segment
        segments.push(`M${x.toFixed(1)},${TRACK_BASELINE.toFixed(1)} L${x.toFixed(1)},${y.toFixed(1)}`);
        firstX = x;
        inDay = true;
      } else if (above && inDay) {
        segments.push(`L${x.toFixed(1)},${y.toFixed(1)}`);
      } else if (!above && inDay) {
        segments.push(`L${x.toFixed(1)},${TRACK_BASELINE.toFixed(1)} L${firstX.toFixed(1)},${TRACK_BASELINE.toFixed(1)} Z`);
        inDay = false;
      }
    }
    if (inDay) {
      const last = samples[samples.length - 1];
      if (last) {
        const lastX = tToX(last.tUtc);
        segments.push(`L${lastX.toFixed(1)},${TRACK_BASELINE.toFixed(1)} L${firstX.toFixed(1)},${TRACK_BASELINE.toFixed(1)} Z`);
      }
    }
    return segments.join(" ");
  }, [samples, bounds.startUtc, dayMs]);

  const cursorX = tToX(utc);

  // Hour labels every 6 hours
  const hourTicks = useMemo(() => {
    const ticks: Array<{ x: number; label: string }> = [];
    for (let h = 0; h <= 24; h += 6) {
      const t = new Date(bounds.startUtc.getTime() + (h * 60 * 60 * 1000));
      ticks.push({ x: tToX(t), label: h === 24 ? "24" : pad2(h) });
    }
    return ticks;
  }, [bounds.startUtc, dayMs]);

  const sunriseValid = Number.isFinite(dayTimes.sunrise.getTime());
  const sunsetValid = Number.isFinite(dayTimes.sunset.getTime());
  const noonValid = Number.isFinite(dayTimes.solarNoon.getTime());

  const daylightHours =
    sunriseValid && sunsetValid
      ? Math.max(0, (dayTimes.sunset.getTime() - dayTimes.sunrise.getTime()) / 3600000)
      : null;

  const handlePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || props.disabled) return;
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const f = (px / rect.width - TRACK_PAD_X / TRACK_WIDTH) / (widthInner / TRACK_WIDTH);
    const clamped = Math.max(0, Math.min(1, f));
    const tMs = bounds.startUtc.getTime() + clamped * dayMs;
    const t = new Date(tMs);
    if (Number.isFinite(t.getTime())) {
      props.onChange(t.toISOString());
    }
  };

  const labelDaylight =
    daylightHours !== null
      ? `${daylightHours.toFixed(1)}h daylight`
      : props.location.lat > 66 || props.location.lat < -66
        ? dayTimes.sunrise instanceof Date && Number.isNaN(dayTimes.sunrise.getTime())
          ? "Polar day/night"
          : "—"
        : "—";

  return (
    <div className="widget-datetime-track">
      <div className="widget-datetime-track-header">
        <span>{labelDaylight}</span>
        <span className="widget-datetime-track-times">
          {sunriseValid ? <span title="Sunrise">↑ {formatLocalHourMinute(dayTimes.sunrise, props.ianaName)}</span> : null}
          {noonValid ? <span title="Solar noon">☼ {formatLocalHourMinute(dayTimes.solarNoon, props.ianaName)}</span> : null}
          {sunsetValid ? <span title="Sunset">↓ {formatLocalHourMinute(dayTimes.sunset, props.ianaName)}</span> : null}
        </span>
      </div>
      <svg
        ref={svgRef}
        className="widget-datetime-track-svg"
        viewBox={`0 0 ${TRACK_WIDTH} ${TRACK_HEIGHT}`}
        preserveAspectRatio="none"
        onPointerDown={(event) => {
          if (props.disabled) return;
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
          setDragging(true);
          handlePointer(event);
        }}
        onPointerMove={(event) => {
          if (!dragging) return;
          handlePointer(event);
        }}
        onPointerUp={(event) => {
          (event.currentTarget as Element).releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        style={{ cursor: props.disabled ? "default" : "ew-resize" }}
      >
        <defs>
          <linearGradient id="daylightGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#f9c969" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#f6863a" stopOpacity="0.45" />
          </linearGradient>
        </defs>
        {/* Background */}
        <rect x={0} y={0} width={TRACK_WIDTH} height={TRACK_HEIGHT} fill="#0e1726" />
        {/* Day-fill region */}
        {dayFillD ? <path d={dayFillD} fill="url(#daylightGradient)" /> : null}
        {/* Horizon line (altitude = 0) */}
        <line
          x1={TRACK_PAD_X}
          y1={altToY(0)}
          x2={TRACK_WIDTH - TRACK_PAD_X}
          y2={altToY(0)}
          stroke="#3a4a64"
          strokeWidth={0.6}
          strokeDasharray="3 2"
        />
        {/* Altitude curve */}
        {curveD ? <path d={curveD} fill="none" stroke="#ffd66b" strokeWidth={1.4} /> : null}
        {/* Sunrise/sunset/noon markers */}
        {sunriseValid ? (
          <line
            x1={tToX(dayTimes.sunrise)}
            x2={tToX(dayTimes.sunrise)}
            y1={4}
            y2={TRACK_BASELINE}
            stroke="#ff8e3c"
            strokeWidth={0.8}
            strokeDasharray="2 2"
            pointerEvents="none"
          />
        ) : null}
        {noonValid ? (
          <line
            x1={tToX(dayTimes.solarNoon)}
            x2={tToX(dayTimes.solarNoon)}
            y1={4}
            y2={TRACK_BASELINE}
            stroke="#ffd66b"
            strokeWidth={0.7}
            strokeDasharray="1 2"
            pointerEvents="none"
          />
        ) : null}
        {sunsetValid ? (
          <line
            x1={tToX(dayTimes.sunset)}
            x2={tToX(dayTimes.sunset)}
            y1={4}
            y2={TRACK_BASELINE}
            stroke="#ff8e3c"
            strokeWidth={0.8}
            strokeDasharray="2 2"
            pointerEvents="none"
          />
        ) : null}
        {/* Hour ticks */}
        {hourTicks.map((tick) => (
          <g key={tick.label} pointerEvents="none">
            <line
              x1={tick.x}
              x2={tick.x}
              y1={TRACK_BASELINE}
              y2={TRACK_BASELINE + 3}
              stroke="#3a4a64"
              strokeWidth={0.6}
            />
            <text
              x={tick.x}
              y={TRACK_HEIGHT - 2}
              textAnchor="middle"
              fontSize="8"
              fill="#7591b5"
            >
              {tick.label}
            </text>
          </g>
        ))}
        {/* Current-time cursor */}
        <line
          x1={cursorX}
          x2={cursorX}
          y1={2}
          y2={TRACK_BASELINE + 3}
          stroke="#ff5b6e"
          strokeWidth={1.4}
          pointerEvents="none"
        />
        <circle cx={cursorX} cy={altToY(0)} r={2.6} fill="#ff5b6e" stroke="#ffffff" strokeWidth={0.8} pointerEvents="none" />
      </svg>
    </div>
  );
}
