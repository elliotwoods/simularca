import { useEffect, useMemo, useRef, useState } from "react";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";
import { DigitScrubInput } from "@/ui/widgets/DigitScrubInput";
import {
  WORLD_MAP_HEIGHT,
  WORLD_MAP_PATHS,
  WORLD_MAP_VIEWBOX,
  WORLD_MAP_WIDTH
} from "@/ui/widgets/data/worldMapPaths";
import {
  buildNightRegionPath,
  computeSubsolarPoint,
  projectLngLat,
  unprojectXY
} from "@/ui/widgets/data/sunGeometry";
import { searchPlaces, type GeocodeResult } from "@/ui/widgets/data/geocodeNominatim";
import type { LocationParameterValue, TimezoneParameterValue } from "@/core/types";

interface LocationFieldProps {
  label: string;
  description?: string;
  value: LocationParameterValue;
  showElevation?: boolean;
  mixed?: boolean;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onChange: (value: LocationParameterValue) => void;
  /** When set, day/night overlay renders at this UTC instant. Pass null to suppress. */
  siblingUtcDate?: Date | null;
  /** Optional — currently informational; future use for marker labels. */
  siblingTimezone?: TimezoneParameterValue | null;
}

export function LocationField(props: LocationFieldProps) {
  const { value, showElevation = true, disabled, mixed, onChange, siblingUtcDate } = props;

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "error" | "no-results">("idle");
  const searchTimerRef = useRef<number | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (searchTimerRef.current !== null) {
      window.clearTimeout(searchTimerRef.current);
    }
    if (searchQuery.trim().length < 2) {
      setSearchResults([]);
      setSearchStatus("idle");
      return;
    }
    setSearchStatus("loading");
    searchTimerRef.current = window.setTimeout(async () => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
      const controller = new AbortController();
      searchAbortRef.current = controller;
      try {
        const results = await searchPlaces(searchQuery, controller.signal);
        if (!controller.signal.aborted) {
          setSearchResults(results);
          setSearchStatus(results.length === 0 ? "no-results" : "idle");
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setSearchStatus("error");
          setSearchResults([]);
        }
        void error;
      }
    }, 400);
    return () => {
      if (searchTimerRef.current !== null) {
        window.clearTimeout(searchTimerRef.current);
      }
    };
  }, [searchQuery]);

  useEffect(() => {
    return () => {
      if (searchAbortRef.current) {
        searchAbortRef.current.abort();
      }
    };
  }, []);

  const update = (patch: Partial<LocationParameterValue>) => {
    onChange({
      lat: patch.lat ?? value.lat,
      lng: patch.lng ?? value.lng,
      elevation: patch.elevation !== undefined ? patch.elevation : value.elevation
    });
  };

  const onPickResult = (r: GeocodeResult) => {
    update({ lat: r.lat, lng: r.lng });
    setSearchQuery("");
    setSearchResults([]);
    setSearchStatus("idle");
  };

  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={disabled}
      resetAlign="start"
    >
      <div className="widget-location">
        <div className="widget-location-search">
          <input
            type="search"
            className="widget-text-input"
            placeholder="Search city or place…"
            value={searchQuery}
            disabled={disabled}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          {searchStatus === "loading" ? <span className="widget-location-search-hint">Searching…</span> : null}
          {searchStatus === "error" ? <span className="widget-location-search-hint">Search unavailable</span> : null}
          {searchStatus === "no-results" ? <span className="widget-location-search-hint">No matches</span> : null}
          {searchResults.length > 0 ? (
            <ul className="widget-location-results">
              {searchResults.map((r, idx) => (
                <li key={`${r.lat}-${r.lng}-${idx}`}>
                  <button
                    type="button"
                    className="widget-location-result"
                    onClick={() => onPickResult(r)}
                    disabled={disabled}
                  >
                    <span className="widget-location-result-name">{r.displayName}</span>
                    <span className="widget-location-result-coords">
                      {r.lat.toFixed(2)}, {r.lng.toFixed(2)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        <WorldMapPicker
          lat={value.lat}
          lng={value.lng}
          disabled={disabled}
          siblingUtcDate={siblingUtcDate ?? null}
          onPick={(lat, lng) => update({ lat, lng })}
        />

        <div className="widget-location-row">
          <span className="widget-location-axis">Lat</span>
          <DigitScrubInput
            className="widget-digit-input-rangeless"
            value={value.lat}
            mixed={mixed}
            precision={4}
            min={-90}
            max={90}
            step={0.0001}
            disabled={disabled}
            onChange={(next) => update({ lat: next })}
          />
        </div>
        <div className="widget-location-row">
          <span className="widget-location-axis">Lng</span>
          <DigitScrubInput
            className="widget-digit-input-rangeless"
            value={value.lng}
            mixed={mixed}
            precision={4}
            min={-180}
            max={180}
            step={0.0001}
            disabled={disabled}
            onChange={(next) => update({ lng: next })}
          />
        </div>
        {showElevation ? (
          <div className="widget-location-row">
            <span className="widget-location-axis">Elev</span>
            <DigitScrubInput
              className="widget-digit-input-rangeless"
              value={value.elevation ?? 0}
              mixed={mixed}
              precision={2}
              step={1}
              disabled={disabled}
              onChange={(next) => update({ elevation: next })}
            />
            <span className="widget-number-unit">m</span>
          </div>
        ) : null}
      </div>
    </InspectorFieldRow>
  );
}

interface WorldMapPickerProps {
  lat: number;
  lng: number;
  disabled?: boolean;
  siblingUtcDate: Date | null;
  onPick: (lat: number, lng: number) => void;
}

function WorldMapPicker(props: WorldMapPickerProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const pin = useMemo(() => projectLngLat(props.lng, props.lat), [props.lat, props.lng]);

  const nightPath = useMemo(() => {
    if (!props.siblingUtcDate || !Number.isFinite(props.siblingUtcDate.getTime())) {
      return null;
    }
    return buildNightRegionPath(props.siblingUtcDate);
  }, [props.siblingUtcDate]);

  const subsolar = useMemo(() => {
    if (!props.siblingUtcDate || !Number.isFinite(props.siblingUtcDate.getTime())) {
      return null;
    }
    const sub = computeSubsolarPoint(props.siblingUtcDate);
    return projectLngLat(sub.lng, sub.lat);
  }, [props.siblingUtcDate]);

  const pickFromEvent = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const x = (px / rect.width) * WORLD_MAP_WIDTH;
    const y = (py / rect.height) * WORLD_MAP_HEIGHT;
    const { lat, lng } = unprojectXY(x, y);
    props.onPick(lat, lng);
  };

  return (
    <div className="widget-location-map-wrap">
      <svg
        ref={svgRef}
        className="widget-location-map-svg"
        viewBox={WORLD_MAP_VIEWBOX}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={(event) => {
          if (props.disabled) return;
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
          setDragging(true);
          pickFromEvent(event);
        }}
        onPointerMove={(event) => {
          if (!dragging || props.disabled) return;
          pickFromEvent(event);
        }}
        onPointerUp={(event) => {
          if (props.disabled) return;
          (event.currentTarget as Element).releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        style={{ cursor: props.disabled ? "default" : dragging ? "grabbing" : "crosshair" }}
      >
        {/* Ocean */}
        <rect x={0} y={0} width={WORLD_MAP_WIDTH} height={WORLD_MAP_HEIGHT} fill="#0e2236" />
        {/* Continents */}
        <g fill="#2c4f73" stroke="#3a6892" strokeWidth={0.4}>
          {WORLD_MAP_PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
        {/* Equator + prime meridian */}
        <g stroke="#1f3954" strokeWidth={0.3} strokeDasharray="2 2" pointerEvents="none">
          <line x1={0} y1={WORLD_MAP_HEIGHT / 2} x2={WORLD_MAP_WIDTH} y2={WORLD_MAP_HEIGHT / 2} />
          <line x1={WORLD_MAP_WIDTH / 2} y1={0} x2={WORLD_MAP_WIDTH / 2} y2={WORLD_MAP_HEIGHT} />
        </g>
        {/* Day/night overlay */}
        {nightPath ? (
          <path d={nightPath} fill="rgba(8, 12, 24, 0.55)" pointerEvents="none" />
        ) : null}
        {/* Subsolar marker */}
        {subsolar ? (
          <g pointerEvents="none">
            <circle cx={subsolar.x} cy={subsolar.y} r={3.5} fill="#ffd66b" stroke="#ffaa1c" strokeWidth={0.6} />
            <circle cx={subsolar.x} cy={subsolar.y} r={6.5} fill="none" stroke="rgba(255, 214, 107, 0.55)" strokeWidth={0.6} />
          </g>
        ) : null}
        {/* Pin */}
        <g pointerEvents="none">
          <circle cx={pin.x} cy={pin.y} r={4.5} fill="#ff5b6e" stroke="#ffffff" strokeWidth={1} />
          <circle cx={pin.x} cy={pin.y} r={1.5} fill="#ffffff" />
        </g>
      </svg>
    </div>
  );
}
