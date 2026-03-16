interface KeyboardMapModalProps {
  open: boolean;
  onClose(): void;
}

const SHORTCUTS = [
  { key: "Space", action: "Play / Pause simulation" },
  { key: "Delete", action: "Delete current selection" },
  { key: "Ctrl/Cmd + S", action: "Save project" },
  { key: "Ctrl/Cmd + Shift + S", action: "Save snapshot as..." },
  { key: "Ctrl/Cmd + Z", action: "Undo" },
  { key: "Ctrl/Cmd + Shift + Z", action: "Redo" },
  { key: "G / R / S", action: "Translate / rotate / scale selected actor" },
  { key: "?", action: "Toggle keyboard map" }
];

const VIEWPORT_SHORTCUTS = [
  { key: "LMB", action: "Orbit around the point under the cursor" },
  { key: "Wheel", action: "Zoom around the point under the cursor" },
  { key: "RMB", action: "Fly-look camera rotation" },
  { key: "RMB + W / A / S / D / Q / E", action: "Fly camera while right mouse is held" },
  { key: "MMB or LMB + RMB", action: "Pan in the camera plane" },
  { key: "Double MMB", action: "Home the viewport to the fixed isometric perspective view" },
  { key: "1 / 3 / 7", action: "Front / right / top orthographic view when the mouse is over the viewport" },
  { key: "Press 1 / 3 / 7 again", action: "Flip to back / left / bottom" },
  { key: "2 / 4 / 6 / 8", action: "Step orbit around the current target" },
  { key: "5", action: "Toggle perspective / orthographic view" },
  { key: "9", action: "Flip to the opposite view around the current target" },
  { key: "F", action: "Frame selected object (planned)" },
];

export function KeyboardMapModal(props: KeyboardMapModalProps) {
  if (!props.open) {
    return null;
  }

  return (
    <div className="keyboard-map-backdrop" onClick={props.onClose}>
      <div className="keyboard-map" onClick={(event) => event.stopPropagation()}>
        <h3>Keyboard Map</h3>
        <ul>
          {SHORTCUTS.map((entry) => (
            <li key={entry.key}>
              <kbd>{entry.key}</kbd>
              <span>{entry.action}</span>
            </li>
          ))}
        </ul>
        <h3>Viewport Camera</h3>
        <ul>
          {VIEWPORT_SHORTCUTS.map((entry) => (
            <li key={entry.key}>
              <kbd>{entry.key}</kbd>
              <span>{entry.action}</span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

