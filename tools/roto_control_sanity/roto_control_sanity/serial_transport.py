from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, List, Optional, Sequence

import serial
from serial.tools import list_ports

from .logging_utils import bytes_to_hex
from .protocol import (
    SERIAL_MESSAGE_RESPONSE,
    SERIAL_RESPONSE_OK,
    SERIAL_RESPONSE_UNCONFIGURED,
    build_demo_plugin,
    build_demo_serial_knob_configs,
    build_serial_end_config_update_request,
    build_serial_get_mode_request,
    build_serial_get_version_request,
    build_serial_plugin_add_request,
    build_serial_plugin_get_current_request,
    build_serial_plugin_get_first_request,
    build_serial_plugin_get_knob_config_request,
    build_serial_plugin_get_next_request,
    build_serial_plugin_set_knob_config_request,
    build_serial_start_config_update_request,
    build_serial_set_mode_request,
    parse_serial_mode_payload,
    parse_serial_plugin_payload,
    parse_serial_version_payload,
    stable_hash_8,
)


def list_serial_ports() -> List[dict]:
    ports = []
    for entry in list_ports.comports():
        ports.append(
            {
                "device": entry.device,
                "description": entry.description,
                "manufacturer": entry.manufacturer,
                "vid": f"{entry.vid:04X}" if entry.vid is not None else None,
                "pid": f"{entry.pid:04X}" if entry.pid is not None else None,
                "serial_number": entry.serial_number,
                "location": entry.location,
                "pnp_id": entry.hwid,
            }
        )
    return ports


def choose_serial_port(explicit: Optional[str] = None) -> str:
    ports = list_serial_ports()
    if explicit:
        for entry in ports:
            if entry["device"] == explicit:
                return explicit
        raise RuntimeError(f"Serial port '{explicit}' was not found. Available: {[entry['device'] for entry in ports]}")
    candidates = [entry["device"] for entry in ports if entry["vid"] == "2E8A" and entry["pid"] == "F010"]
    if not candidates:
        raise RuntimeError(f"No compatible serial ports found. Available: {[entry['device'] for entry in ports]}")
    return sorted(candidates)[0]


@dataclass(frozen=True)
class SerialResponse:
    port: str
    response_code: int
    payload: bytes


class SerialAdminSession:
    def __init__(self, port_name: str, logger, timeout_seconds: float = 2.0) -> None:
        self.port_name = port_name
        self.logger = logger
        self.timeout_seconds = timeout_seconds
        self.handle = serial.Serial(port_name, 115200, timeout=0.2)
        self.logger.info("Opened serial admin port '%s' at 115200 baud.", port_name)

    def close(self) -> None:
        if self.handle.is_open:
            self.handle.close()

    def __enter__(self) -> "SerialAdminSession":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def _read_exactly(self, byte_count: int, timeout_seconds: Optional[float] = None) -> bytes:
        deadline = time.monotonic() + (self.timeout_seconds if timeout_seconds is None else timeout_seconds)
        data = bytearray()
        while len(data) < byte_count:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out reading {byte_count} serial bytes from {self.port_name}.")
            chunk = self.handle.read(byte_count - len(data))
            if chunk:
                data.extend(chunk)
        return bytes(data)

    def request(self, payload: bytes, expected_bytes: int, timeout_seconds: Optional[float] = None) -> SerialResponse:
        self.logger.info("SERIAL OUT %s", bytes_to_hex(payload))
        self.handle.reset_input_buffer()
        self.handle.write(payload)
        self.handle.flush()

        deadline = time.monotonic() + (self.timeout_seconds if timeout_seconds is None else timeout_seconds)
        while True:
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for serial response from {self.port_name}.")
            message_type = self.handle.read(1)
            if not message_type:
                continue
            if message_type[0] != SERIAL_MESSAGE_RESPONSE:
                self.logger.info("SERIAL IN  stray %02X", message_type[0])
                continue
            response_code = self._read_exactly(1, deadline - time.monotonic())[0]
            response_payload = self._read_exactly(expected_bytes, deadline - time.monotonic()) if expected_bytes else b""
            self.logger.info("SERIAL IN  %s %s", f"{response_code:02X}", bytes_to_hex(response_payload))
            return SerialResponse(port=self.port_name, response_code=response_code, payload=response_payload)


def _require_ok(response: SerialResponse) -> bytes:
    if response.response_code != SERIAL_RESPONSE_OK:
        raise RuntimeError(f"Serial request failed on {response.port} with response code 0x{response.response_code:02X}.")
    return response.payload


def read_serial_snapshot(port_name: str, duration_seconds: float, logger) -> dict:
    logger.info("Opening serial port '%s' at 115200 baud.", port_name)
    with serial.Serial(port_name, 115200, timeout=0.2) as handle:
        start = time.monotonic()
        received = bytearray()
        while time.monotonic() - start < duration_seconds:
            chunk = handle.read(256)
            if chunk:
                received.extend(chunk)
        logger.info("SERIAL IN %s", bytes_to_hex(received))
        return {
            "port": port_name,
            "byte_count": len(received),
            "hex": bytes_to_hex(received),
        }


def send_serial_bytes(port_name: str, payload: bytes, duration_seconds: float, logger) -> dict:
    logger.info("Opening serial port '%s' at 115200 baud.", port_name)
    with serial.Serial(port_name, 115200, timeout=0.2) as handle:
        logger.info("SERIAL OUT %s", bytes_to_hex(payload))
        handle.write(payload)
        handle.flush()
        start = time.monotonic()
        received = bytearray()
        while time.monotonic() - start < duration_seconds:
            chunk = handle.read(256)
            if chunk:
                received.extend(chunk)
        logger.info("SERIAL IN %s", bytes_to_hex(received))
        return {
            "port": port_name,
            "tx_hex": bytes_to_hex(payload),
            "rx_byte_count": len(received),
            "rx_hex": bytes_to_hex(received),
        }


def query_serial_version(port_name: str, logger) -> dict:
    with SerialAdminSession(port_name, logger) as session:
        payload = _require_ok(session.request(build_serial_get_version_request(), 10))
    return {"port": port_name, **parse_serial_version_payload(payload)}


def query_serial_mode(port_name: str, logger) -> dict:
    with SerialAdminSession(port_name, logger) as session:
        payload = _require_ok(session.request(build_serial_get_mode_request(), 2))
    return {"port": port_name, **parse_serial_mode_payload(payload)}


def set_serial_mode(port_name: str, mode_name: str, first_visible_control_index: int, logger) -> dict:
    with SerialAdminSession(port_name, logger) as session:
        response = session.request(build_serial_set_mode_request(mode_name, first_visible_control_index), 0)
    _require_ok(response)
    return {
        "port": port_name,
        "mode": mode_name.upper(),
        "first_visible_control_index": first_visible_control_index,
    }


def query_serial_current_plugin(port_name: str, logger) -> dict:
    with SerialAdminSession(port_name, logger) as session:
        response = session.request(build_serial_plugin_get_current_request(), 23)
    if response.response_code == SERIAL_RESPONSE_UNCONFIGURED:
        return {"port": port_name, "unconfigured": True}
    payload = _require_ok(response)
    return {"port": port_name, **parse_serial_plugin_payload(payload, include_daw_type=True)}


def enumerate_serial_plugins(port_name: str, logger) -> dict:
    plugins: List[dict] = []
    with SerialAdminSession(port_name, logger) as session:
        response = session.request(build_serial_plugin_get_first_request(), 22)
        if response.response_code == SERIAL_RESPONSE_UNCONFIGURED:
            return {"port": port_name, "plugins": []}
        plugins.append(parse_serial_plugin_payload(_require_ok(response)))
        while True:
            response = session.request(build_serial_plugin_get_next_request(), 22)
            if response.response_code == SERIAL_RESPONSE_UNCONFIGURED:
                break
            plugins.append(parse_serial_plugin_payload(_require_ok(response)))
    return {"port": port_name, "plugins": plugins}


def configure_demo_plugin(port_name: str, logger) -> dict:
    plugin = build_demo_plugin()
    knob_configs = build_demo_serial_knob_configs(plugin)
    with SerialAdminSession(port_name, logger, timeout_seconds=3.0) as session:
        _require_ok(session.request(build_serial_start_config_update_request(), 0))
        _require_ok(session.request(build_serial_plugin_add_request(plugin), 0))
        for config in knob_configs:
            _require_ok(session.request(build_serial_plugin_set_knob_config_request(plugin, config), 0))
        _require_ok(session.request(build_serial_end_config_update_request(), 0))
        current = session.request(build_serial_plugin_get_current_request(), 23)
        first_plugin = session.request(build_serial_plugin_get_first_request(), 22)
        first_knob = session.request(build_serial_plugin_get_knob_config_request(plugin, 0), 40 + (16 * 13))
    current_result = {"unconfigured": True} if current.response_code == SERIAL_RESPONSE_UNCONFIGURED else parse_serial_plugin_payload(_require_ok(current), include_daw_type=True)
    first_plugin_result = {"unconfigured": True} if first_plugin.response_code == SERIAL_RESPONSE_UNCONFIGURED else parse_serial_plugin_payload(_require_ok(first_plugin))
    return {
        "port": port_name,
        "configured_plugin": plugin.name,
        "plugin_hash": bytes_to_hex(stable_hash_8(plugin.plugin_hash_source)),
        "knob_count": len(knob_configs),
        "current_plugin": current_result,
        "first_plugin": first_plugin_result,
        "first_knob_response_code": first_knob.response_code,
        "first_knob_payload_length": len(first_knob.payload),
    }
