import { useMemo, useState } from "react";
import { InspectorFieldRow } from "@/ui/widgets/InspectorFieldRow";
import type { TimezoneParameterValue } from "@/core/types";

interface TimezoneFieldProps {
  label: string;
  description?: string;
  value: TimezoneParameterValue;
  mixed?: boolean;
  disabled?: boolean;
  showReset?: boolean;
  onReset?: () => void;
  onChange: (value: TimezoneParameterValue) => void;
}

function listSupportedTimezones(): string[] {
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  if (typeof intl.supportedValuesOf === "function") {
    try {
      return intl.supportedValuesOf("timeZone");
    } catch {
      // fall through
    }
  }
  return ["UTC", "Europe/London", "Europe/Paris", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
}

export function TimezoneField(props: TimezoneFieldProps) {
  const { value, disabled, onChange } = props;
  const zones = useMemo(() => listSupportedTimezones(), []);
  const [filter, setFilter] = useState("");
  const filtered = useMemo(() => {
    const lower = filter.toLowerCase();
    return lower ? zones.filter((z) => z.toLowerCase().includes(lower)) : zones;
  }, [zones, filter]);

  return (
    <InspectorFieldRow
      label={props.label}
      description={props.description}
      showReset={props.showReset}
      onReset={props.onReset}
      resetDisabled={disabled}
      resetAlign="start"
    >
      <div className="widget-timezone">
        <div className="widget-timezone-mode">
          <label>
            <input
              type="radio"
              name={`tz-mode-${props.label}`}
              checked={value.mode === "auto"}
              disabled={disabled}
              onChange={() => onChange({ mode: "auto", ianaName: value.ianaName })}
            />
            Auto from location
          </label>
          <label>
            <input
              type="radio"
              name={`tz-mode-${props.label}`}
              checked={value.mode === "manual"}
              disabled={disabled}
              onChange={() => onChange({ mode: "manual", ianaName: value.ianaName ?? "UTC" })}
            />
            Manual
          </label>
        </div>
        {value.mode === "manual" ? (
          <>
            <input
              type="search"
              className="widget-text-input"
              value={filter}
              placeholder="Search timezones..."
              disabled={disabled}
              onChange={(event) => setFilter(event.target.value)}
            />
            <select
              className="widget-select"
              value={value.ianaName ?? "UTC"}
              disabled={disabled}
              onChange={(event) => onChange({ mode: "manual", ianaName: event.target.value })}
              size={Math.min(8, Math.max(3, filtered.length))}
            >
              {filtered.map((zone) => (
                <option key={zone} value={zone}>{zone}</option>
              ))}
            </select>
          </>
        ) : null}
      </div>
    </InspectorFieldRow>
  );
}
