from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict

from .logging_utils import configure_logging, default_log_path
from .midi_transport import MidiSession, list_midi_ports, select_port_name
from .publisher import perform_handshake, probe_plugin_displays, publish_demo_bank
from .serial_transport import (
    choose_serial_port,
    configure_demo_plugin,
    enumerate_serial_plugins,
    list_serial_ports,
    query_serial_current_plugin,
    query_serial_mode,
    query_serial_version,
    read_serial_snapshot,
    send_serial_bytes,
    set_serial_mode,
)


def add_common_midi_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--midi-input", help="Explicit MIDI input name.")
    parser.add_argument("--midi-output", help="Explicit MIDI output name.")
    parser.add_argument("--daw", choices=["ableton", "bitwig"], default="ableton", help="DAW emulation mode.")
    parser.add_argument("--timeout", type=float, default=10.0, help="Handshake timeout in seconds.")


def print_json(data: Dict[str, Any]) -> None:
    print(json.dumps(data, indent=2))


def command_scan(_args: argparse.Namespace, logger) -> int:
    data = {
        "midi": list_midi_ports(),
        "serial": list_serial_ports(),
    }
    logger.info("Completed hardware scan.")
    print_json(data)
    return 0


def open_midi_session(args: argparse.Namespace, logger) -> MidiSession:
    ports = list_midi_ports()
    input_name = select_port_name(ports["inputs"], args.midi_input)
    output_name = select_port_name(ports["outputs"], args.midi_output)
    return MidiSession(input_name=input_name, output_name=output_name, logger=logger)


def command_handshake(args: argparse.Namespace, logger) -> int:
    session = open_midi_session(args, logger)
    try:
        result = perform_handshake(session, logger, args.daw, args.timeout)
    finally:
        session.close()
    print_json(result)
    return 0


def command_publish_demo(args: argparse.Namespace, logger) -> int:
    session = open_midi_session(args, logger)
    try:
        handshake = perform_handshake(session, logger, args.daw, args.timeout)
        publish = publish_demo_bank(session, logger)
    finally:
        session.close()
    print_json(
        {
            "handshake": handshake,
            "publish": publish,
        }
    )
    return 0


def command_probe_displays(args: argparse.Namespace, logger) -> int:
    session = open_midi_session(args, logger)
    try:
        handshake = perform_handshake(session, logger, args.daw, args.timeout)
        publish = publish_demo_bank(session, logger)
        probe = probe_plugin_displays(session, logger, args.dwell)
    finally:
        session.close()
    print_json(
        {
            "handshake": handshake,
            "publish": publish,
            "probe": probe,
        }
    )
    return 0


def command_listen(args: argparse.Namespace, logger) -> int:
    session = open_midi_session(args, logger)
    try:
        events = session.listen(args.seconds)
    finally:
        session.close()
    print_json(
        {
            "event_count": len(events),
            "events": [{"kind": event.kind, "raw_bytes": event.raw_bytes, "message": event.message_repr} for event in events],
        }
    )
    return 0


def command_serial_info(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    result = read_serial_snapshot(port, args.seconds, logger)
    print_json(result)
    return 0


def parse_hex_bytes(hex_string: str) -> bytes:
    cleaned = hex_string.replace(",", " ").replace("-", " ")
    values = [part for part in cleaned.split() if part]
    if not values:
        raise RuntimeError("No serial bytes were provided.")
    return bytes(int(value, 16) & 0xFF for value in values)


def command_serial_send(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    payload = parse_hex_bytes(args.hex)
    result = send_serial_bytes(port, payload, args.seconds, logger)
    print_json(result)
    return 0


def command_serial_get_version(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    print_json(query_serial_version(port, logger))
    return 0


def command_serial_get_mode(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    print_json(query_serial_mode(port, logger))
    return 0


def command_serial_set_mode(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    print_json(set_serial_mode(port, args.mode, args.first_visible_control_index, logger))
    return 0


def command_serial_plugins(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    print_json(
        {
            "current": query_serial_current_plugin(port, logger),
            "all": enumerate_serial_plugins(port, logger),
        }
    )
    return 0


def command_serial_configure_demo_plugin(args: argparse.Namespace, logger) -> int:
    port = choose_serial_port(args.port)
    print_json(configure_demo_plugin(port, logger))
    return 0


def command_compare_electron(args: argparse.Namespace, logger) -> int:
    log_path = Path(args.electron_log_path)
    if not log_path.exists():
        raise RuntimeError(f"Electron runtime log was not found at {log_path}.")
    matches = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        if "[roto] Publishing Roto bank" not in line:
            continue
        json_start = line.find("{")
        if json_start < 0:
            continue
        matches.append(json.loads(line[json_start:]))
    logger.info("Compared %s Electron publish records.", len(matches))
    print_json(
        {
            "publish_count": len(matches),
            "publishes": matches[-10:],
        }
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Standalone Roto-Control sanity harness.")
    parser.add_argument("--log-path", default=str(default_log_path()), help="Log file path.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scan_parser = subparsers.add_parser("scan", help="List MIDI and serial ports.")
    scan_parser.set_defaults(func=command_scan)

    handshake_parser = subparsers.add_parser("handshake", help="Perform the DAW-style SysEx handshake.")
    add_common_midi_arguments(handshake_parser)
    handshake_parser.set_defaults(func=command_handshake)

    publish_parser = subparsers.add_parser("publish-demo", help="Handshake and publish a fixed 8-slot bank.")
    add_common_midi_arguments(publish_parser)
    publish_parser.set_defaults(func=command_publish_demo)

    probe_parser = subparsers.add_parser(
        "probe-displays",
        help="Handshake, publish the demo bank, then probe runtime knob displays with CC/touch/name/value updates.",
    )
    add_common_midi_arguments(probe_parser)
    probe_parser.add_argument("--dwell", type=float, default=0.15, help="Pause between probed slots in seconds.")
    probe_parser.set_defaults(func=command_probe_displays)

    listen_parser = subparsers.add_parser("listen", help="Listen to inbound MIDI for a fixed duration.")
    listen_parser.add_argument("--midi-input", help="Explicit MIDI input name.")
    listen_parser.add_argument("--midi-output", help="Explicit MIDI output name.")
    listen_parser.add_argument("--seconds", type=float, default=20.0, help="Listen duration in seconds.")
    listen_parser.set_defaults(func=command_listen)

    serial_parser = subparsers.add_parser("serial-info", help="Open the serial port and capture any inbound bytes.")
    serial_parser.add_argument("--port", help="Explicit serial port override, e.g. COM4.")
    serial_parser.add_argument("--seconds", type=float, default=5.0, help="Read duration in seconds.")
    serial_parser.set_defaults(func=command_serial_info)

    serial_send_parser = subparsers.add_parser("serial-send", help="Send raw hex bytes to the serial port and capture any response.")
    serial_send_parser.add_argument("--port", help="Explicit serial port override, e.g. COM4.")
    serial_send_parser.add_argument("--hex", required=True, help="Hex bytes to send, e.g. '5A 01 04'.")
    serial_send_parser.add_argument("--seconds", type=float, default=2.0, help="Read duration after sending.")
    serial_send_parser.set_defaults(func=command_serial_send)

    serial_version_parser = subparsers.add_parser("serial-get-version", help="Query firmware version over the serial admin port.")
    serial_version_parser.add_argument("--port", help="Explicit serial port override, e.g. COM3.")
    serial_version_parser.set_defaults(func=command_serial_get_version)

    serial_mode_parser = subparsers.add_parser("serial-get-mode", help="Query current controller mode over the serial admin port.")
    serial_mode_parser.add_argument("--port", help="Explicit serial port override, e.g. COM3.")
    serial_mode_parser.set_defaults(func=command_serial_get_mode)

    serial_set_mode_parser = subparsers.add_parser("serial-set-mode", help="Set controller mode over the serial admin port.")
    serial_set_mode_parser.add_argument("--port", help="Explicit serial port override, e.g. COM3.")
    serial_set_mode_parser.add_argument("--mode", choices=["MIDI", "PLUGIN", "MIX"], required=True, help="Target controller mode.")
    serial_set_mode_parser.add_argument("--first-visible-control-index", type=int, default=0, help="First visible control index for the selected mode.")
    serial_set_mode_parser.set_defaults(func=command_serial_set_mode)

    serial_plugins_parser = subparsers.add_parser("serial-plugins", help="Query current and stored plugin configs over the serial admin port.")
    serial_plugins_parser.add_argument("--port", help="Explicit serial port override, e.g. COM3.")
    serial_plugins_parser.set_defaults(func=command_serial_plugins)

    serial_configure_plugin_parser = subparsers.add_parser("serial-configure-demo-plugin", help="Write a demo plugin config and 8 knob mappings over the serial admin port.")
    serial_configure_plugin_parser.add_argument("--port", help="Explicit serial port override, e.g. COM3.")
    serial_configure_plugin_parser.set_defaults(func=command_serial_configure_demo_plugin)

    compare_parser = subparsers.add_parser("compare-electron", help="Show recent Electron publish-bank records from the runtime log.")
    compare_parser.add_argument(
        "--electron-log-path",
        default=str(default_log_path().parent / "electron-runtime.log"),
        help="Electron runtime log path."
    )
    compare_parser.set_defaults(func=command_compare_electron)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    logger = configure_logging(Path(args.log_path))
    try:
        return int(args.func(args, logger))
    except Exception as error:  # pragma: no cover - CLI guard
        logger.exception("Command failed: %s", error)
        print_json({"ok": False, "error": str(error)})
        return 1
