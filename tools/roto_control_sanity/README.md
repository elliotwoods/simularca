# Roto-Control Python Sanity Harness

This is a standalone Python CLI for validating Melbourne Instruments Roto-Control connectivity outside Electron.

It is intentionally simple:
- discover MIDI and serial ports
- perform the DAW-style SysEx handshake
- publish a fixed 8-slot demo bank
- log raw MIDI/SysEx traffic

## Setup

From the repo root:

```powershell
cd tools\roto_control_sanity
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## Commands

```powershell
python -m roto_control_sanity scan
python -m roto_control_sanity handshake --daw ableton
python -m roto_control_sanity publish-demo --daw ableton
python -m roto_control_sanity listen --seconds 20
python -m roto_control_sanity serial-info --port COM4
python -m roto_control_sanity serial-send --port COM4 --hex "5A 01 04"
python -m roto_control_sanity compare-electron
python -m unittest discover -s tests -v
```

## Notes

- Leave the controller in `PLUGIN` mode for `handshake` and `publish-demo`.
- The default DAW emulation is `ableton`.
- Logs are written to `logs/roto-python-sanity.log` under the repo root.
- `publish-demo` uses a fixed, obvious test bank so controller updates are easy to spot.
