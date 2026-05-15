interface QuitConfirmModalProps {
  open: boolean;
  onSaveAndQuit: () => void;
  onQuitWithoutSaving: () => void;
  onCancel: () => void;
}

export function QuitConfirmModal(props: QuitConfirmModalProps) {
  if (!props.open) {
    return null;
  }

  return (
    <div
      className="quit-confirm-modal-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <div className="quit-confirm-modal" role="dialog" aria-modal="true" aria-label="Unsaved changes">
        <h3>Unsaved Changes</h3>
        <p>You have unsaved changes. What would you like to do?</p>
        <div className="quit-confirm-modal-actions">
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="quit-without-saving" onClick={props.onQuitWithoutSaving}>
            Quit Without Saving
          </button>
          <button type="button" className="primary" onClick={props.onSaveAndQuit} autoFocus>
            Save and Quit
          </button>
        </div>
      </div>
    </div>
  );
}
