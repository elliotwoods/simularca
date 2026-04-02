from __future__ import annotations

import queue
import time
from dataclasses import dataclass
from typing import Callable, Iterable, List, Optional, Sequence, Tuple

import mido

from .logging_utils import bytes_to_hex
from .protocol import parse_roto_sysex


def list_midi_ports() -> dict:
    return {
        "inputs": list(mido.get_input_names()),
        "outputs": list(mido.get_output_names()),
    }


def select_port_name(names: Sequence[str], explicit: Optional[str], needle: str = "roto") -> str:
    if explicit:
        for name in names:
            if explicit == name:
                return name
        raise RuntimeError(f"Port '{explicit}' was not found. Available: {list(names)}")
    scored = sorted(
        (name for name in names if needle.lower() in name.lower()),
        key=lambda name: (
            0 if "daw" in name.lower() else 1,
            0 if "control" in name.lower() else 1,
            name.lower(),
        ),
    )
    if not scored:
        raise RuntimeError(f"No MIDI ports matching '{needle}' were found. Available: {list(names)}")
    return scored[0]


@dataclass
class MidiEvent:
    kind: str
    raw_bytes: List[int]
    message_repr: str


class MidiSession:
    def __init__(self, input_name: str, output_name: str, logger) -> None:
        self.logger = logger
        self.input_name = input_name
        self.output_name = output_name
        self.sysex_delay_seconds = 0.005
        self._events: "queue.Queue[MidiEvent]" = queue.Queue()
        self._input = mido.open_input(input_name, callback=self._on_message)
        self._output = mido.open_output(output_name)
        self.logger.info("Opened MIDI input '%s' and output '%s'.", input_name, output_name)

    def close(self) -> None:
        self._input.close()
        self._output.close()

    def _on_message(self, message: mido.Message) -> None:
        if message.type == "sysex":
            raw_bytes = [0xF0, *list(message.data), 0xF7]
            kind = "sysex"
        else:
            raw_bytes = message.bytes()
            kind = message.type
        self.logger.info("MIDI IN  %s  %s", kind.upper(), bytes_to_hex(raw_bytes))
        self._events.put(MidiEvent(kind=kind, raw_bytes=raw_bytes, message_repr=str(message)))

    def send_raw(self, message_bytes: Iterable[int]) -> None:
        message_list = list(message_bytes)
        if not message_list:
            return
        self.logger.info("MIDI OUT RAW     %s", bytes_to_hex(message_list))
        self._output.send(mido.Message.from_bytes(message_list))
        time.sleep(self.sysex_delay_seconds)

    def send_sysex_body(self, body: Sequence[int]) -> None:
        self.logger.info("MIDI OUT SYSEX   %s", bytes_to_hex([0xF0, *body, 0xF7]))
        self._output.send(mido.Message("sysex", data=list(body)))
        time.sleep(self.sysex_delay_seconds)

    def wait_for(self, predicate: Callable[[MidiEvent], bool], timeout_seconds: float) -> MidiEvent:
        deadline = time.monotonic() + timeout_seconds
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Timed out waiting for MIDI event.")
            try:
                event = self._events.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError("Timed out waiting for MIDI event.") from error
            if predicate(event):
                return event

    def listen(self, duration_seconds: float) -> List[MidiEvent]:
        deadline = time.monotonic() + duration_seconds
        events: List[MidiEvent] = []
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                event = self._events.get(timeout=max(0.1, remaining))
            except queue.Empty:
                continue
            events.append(event)
        return events

    def wait_for_roto_sysex(self, sub_type: int, timeout_seconds: float) -> Tuple[MidiEvent, dict]:
        def predicate(event: MidiEvent) -> bool:
            if event.kind != "sysex":
                return False
            parsed = parse_roto_sysex(event.raw_bytes[1:-1])
            return bool(parsed and parsed["sub_type"] == sub_type)

        event = self.wait_for(predicate, timeout_seconds)
        parsed = parse_roto_sysex(event.raw_bytes[1:-1])
        if parsed is None:
            raise RuntimeError("Expected Roto SysEx payload but could not parse it.")
        return event, parsed

    def wait_for_roto_message(self, message_type: int, sub_type: int, timeout_seconds: float) -> Tuple[MidiEvent, dict]:
        def predicate(event: MidiEvent) -> bool:
            if event.kind != "sysex":
                return False
            parsed = parse_roto_sysex(event.raw_bytes[1:-1])
            return bool(parsed and parsed["type"] == message_type and parsed["sub_type"] == sub_type)

        event = self.wait_for(predicate, timeout_seconds)
        parsed = parse_roto_sysex(event.raw_bytes[1:-1])
        if parsed is None:
            raise RuntimeError("Expected Roto SysEx payload but could not parse it.")
        return event, parsed
