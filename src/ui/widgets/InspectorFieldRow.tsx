import { useEffect, useRef, useState, type ReactNode } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faRotateLeft } from "@fortawesome/free-solid-svg-icons";

interface InspectorFieldRowProps {
  label: string;
  description?: string;
  children: ReactNode;
  showReset?: boolean;
  resetTitle?: string;
  resetDisabled?: boolean;
  resetAlign?: "center" | "start";
  onReset?: () => void;
}

export function InspectorFieldRow(props: InspectorFieldRowProps) {
  const descriptionRef = useRef<HTMLSpanElement | null>(null);
  const [descriptionOverflowing, setDescriptionOverflowing] = useState(false);

  useEffect(() => {
    if (!props.description) {
      setDescriptionOverflowing(false);
      return;
    }

    const element = descriptionRef.current;
    if (!element) {
      return;
    }

    const updateOverflow = () => {
      const nextOverflowing = element.scrollWidth > element.clientWidth + 1;
      setDescriptionOverflowing(nextOverflowing);
    };

    updateOverflow();
    const observer = new ResizeObserver(() => {
      updateOverflow();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [props.description]);

  return (
    <div className={`widget-row widget-row-field${descriptionOverflowing ? " has-description-tooltip" : ""}`}>
      <div className="widget-row-header">
        <label className="widget-label">{props.label}</label>
        {props.description ? (
          <span ref={descriptionRef} className="widget-description">
            {props.description}
          </span>
        ) : null}
      </div>
      <div className={`widget-row-control-wrap${props.resetAlign === "start" ? " align-start" : ""}`}>
        <div className="widget-row-control">{props.children}</div>
        <button
          type="button"
          className={`widget-reset-button${props.showReset ? "" : " is-hidden"}`}
          title={props.resetTitle ?? `Reset ${props.label}`}
          disabled={!props.showReset || props.resetDisabled}
          onClick={props.onReset}
        >
          <FontAwesomeIcon icon={faRotateLeft} />
        </button>
      </div>
      {props.description && descriptionOverflowing ? (
        <div className="widget-description-popover" role="tooltip">
          {props.description}
        </div>
      ) : null}
    </div>
  );
}
