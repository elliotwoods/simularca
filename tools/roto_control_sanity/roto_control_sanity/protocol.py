from __future__ import annotations

from dataclasses import dataclass, field
from hashlib import sha1
from typing import Iterable, List, Optional, Sequence

from .logging_utils import bytes_to_hex

SERIAL_MESSAGE_COMMAND = 0x5A
SERIAL_MESSAGE_RESPONSE = 0xA5
SERIAL_RESPONSE_OK = 0x00
SERIAL_RESPONSE_UNCONFIGURED = 0xFD

SERIAL_GENERAL = 0x01
SERIAL_GENERAL_GET_FW_VERSION = 0x01
SERIAL_GENERAL_GET_MODE = 0x02
SERIAL_GENERAL_SET_MODE = 0x03
SERIAL_GENERAL_START_CONFIG_UPDATE = 0x04
SERIAL_GENERAL_END_CONFIG_UPDATE = 0x05

SERIAL_PLUGIN = 0x03
SERIAL_PLUGIN_GET_CURRENT_PLUGIN = 0x01
SERIAL_PLUGIN_GET_FIRST_PLUGIN = 0x02
SERIAL_PLUGIN_GET_NEXT_PLUGIN = 0x03
SERIAL_PLUGIN_GET_PLUGIN = 0x04
SERIAL_PLUGIN_SET_PLUGIN = 0x05
SERIAL_PLUGIN_ADD_PLUGIN = 0x06
SERIAL_PLUGIN_SET_PLUGIN_NAME = 0x07
SERIAL_PLUGIN_CLEAR_PLUGIN = 0x08
SERIAL_PLUGIN_GET_KNOB_CONFIG = 0x09
SERIAL_PLUGIN_GET_SWITCH_CONFIG = 0x0A
SERIAL_PLUGIN_SET_KNOB_CONFIG = 0x0B
SERIAL_PLUGIN_SET_SWITCH_CONFIG = 0x0C
SERIAL_PLUGIN_CLEAR_CONTROL_CONFIG = 0x0D
SERIAL_PLUGIN_CONTROL_LEARNED = 0x0E

SERIAL_MODE_NAMES = ["MIDI", "PLUGIN", "MIX"]

SYSEX_PREFIX = [0x00, 0x22, 0x03, 0x02]
GENERAL_TYPE = 0x0A
GENERAL_DAW_STARTED = 0x01
GENERAL_PING_DAW = 0x02
GENERAL_PING_RESPONSE = 0x03
GENERAL_NUM_TRACKS = 0x04
GENERAL_FIRST_TRACK = 0x05
GENERAL_TRACK_DETAILS = 0x07
GENERAL_TRACK_DETAILS_END = 0x08
GENERAL_CONNECTED = 0x0C
GENERAL_CONNECTED_ACK = 0x0D
GENERAL_REQUEST_API_VERSION = 0x0F
GENERAL_API_VERSION = 0x10
PLUGIN_TYPE = 0x0B
PLUGIN_SET_MODE = 0x01
PLUGIN_NUM_DEVICES = 0x02
PLUGIN_FIRST_DEVICE = 0x03
PLUGIN_DEVICE_DETAILS = 0x05
PLUGIN_DEVICE_DETAILS_END = 0x06
PLUGIN_DAW_SELECT_PLUGIN = 0x08
PLUGIN_LEARN_PARAM = 0x0A
PLUGIN_SET_MAPPED_CONTROL_NAME = 0x0F
DAW_TYPE_BYTES = {
    "ableton": 0x01,
    "bitwig": 0x02,
}


@dataclass(frozen=True)
class DemoSlot:
    id: str
    label: str
    normalized_value: float = 0.0
    quantized_step_count: int = 0
    enum_labels: Sequence[str] = field(default_factory=tuple)
    centered: bool = False


@dataclass(frozen=True)
class DemoPlugin:
    index: int
    name: str
    plugin_hash_source: str
    enabled: bool = True
    plugin_type: int = 0
    page_count: int = 0
    slots: Sequence[DemoSlot] = field(default_factory=tuple)


@dataclass(frozen=True)
class SerialPluginKnobConfig:
    control_index: int
    mapped_param: int
    param_hash: Sequence[int]
    macro_param: bool
    min_value: int
    max_value: int
    control_name: str
    color_scheme: int = 0
    haptic_mode: int = 0
    haptic_indent_1: int = 0xFF
    haptic_indent_2: int = 0xFF
    haptic_steps: int = 0
    step_names: Sequence[str] = field(default_factory=tuple)


def u14_to_pair(value: int) -> List[int]:
    clamped = max(0, min(16383, int(round(value))))
    return [((clamped >> 7) & 0x7F), (clamped & 0x7F)]


def normalized_to_u14(value: Optional[float]) -> int:
    if value is None:
        return 0
    clamped = max(0.0, min(1.0, float(value)))
    return int(round(clamped * 16383))


def split_words(label: str) -> List[str]:
    spaced = []
    previous = ""
    for character in label.replace("_", " ").replace("-", " "):
        if previous and previous.islower() and character.isupper():
            spaced.append(" ")
        spaced.append(character)
        previous = character
    return "".join(spaced).split()


def shorten_label(label: str, max_visible: int = 12) -> str:
    ascii_only = "".join(character for character in label if 0x20 <= ord(character) <= 0x7E)
    words = split_words(ascii_only)[:3]
    if not words:
        return "Param"
    separator_budget = max(0, len(words) - 1)
    visible_budget = max(1, max_visible - separator_budget)
    base_budget = visible_budget // len(words)
    remainder = visible_budget - base_budget * len(words)
    parts: List[str] = []
    for word in words:
        allocation = base_budget + (1 if remainder > 0 else 0)
        if remainder > 0:
            remainder -= 1
        parts.append(word if len(word) <= allocation else word[:allocation])
    return " ".join(parts)[:max_visible] or "Param"


def to_ascii_0d(label: str) -> List[int]:
    visible = shorten_label(label, 12)
    result = [0] * 13
    for index, character in enumerate(visible[:12]):
        result[index] = ord(character) & 0x7F
    return result


def stable_hash_6(value: str) -> List[int]:
    return [byte & 0x7F for byte in sha1(value.encode("utf-8")).digest()[:6]]


def stable_hash_8(value: str) -> List[int]:
    return [byte & 0x7F for byte in sha1(value.encode("utf-8")).digest()[:8]]


def build_sysex_body(command_body: Iterable[int]) -> List[int]:
    return [*SYSEX_PREFIX, *command_body]


def build_daw_started_body() -> List[int]:
    return build_sysex_body([GENERAL_TYPE, GENERAL_DAW_STARTED])


def build_ping_response_body(daw_emulation: str) -> List[int]:
    return build_sysex_body([GENERAL_TYPE, GENERAL_PING_RESPONSE, DAW_TYPE_BYTES[daw_emulation]])


def build_connected_ack_body() -> List[int]:
    return build_sysex_body([GENERAL_TYPE, GENERAL_CONNECTED_ACK])


def is_roto_sysex(payload: Sequence[int]) -> bool:
    return list(payload[: len(SYSEX_PREFIX)]) == SYSEX_PREFIX


def parse_roto_sysex(payload: Sequence[int]) -> Optional[dict]:
    if not is_roto_sysex(payload):
        return None
    body = list(payload[len(SYSEX_PREFIX) :])
    if len(body) < 2:
        return None
    return {
        "type": body[0],
        "sub_type": body[1],
        "body": body,
    }


def build_num_tracks_body(track_count: int) -> List[int]:
    msb, lsb = u14_to_pair(track_count)
    return build_sysex_body([GENERAL_TYPE, GENERAL_NUM_TRACKS, msb, lsb])


def build_first_track_body(track_index: int) -> List[int]:
    msb, lsb = u14_to_pair(track_index)
    return build_sysex_body([GENERAL_TYPE, GENERAL_FIRST_TRACK, msb, lsb])


def build_track_details_body(track_index: int, track_name: str, color_index: int = 0, is_foldable: bool = False) -> List[int]:
    msb, lsb = u14_to_pair(track_index)
    return build_sysex_body(
        [GENERAL_TYPE, GENERAL_TRACK_DETAILS, msb, lsb, *to_ascii_0d(track_name), color_index & 0x7F, 0x01 if is_foldable else 0x00]
    )


def build_track_details_end_body() -> List[int]:
    return build_sysex_body([GENERAL_TYPE, GENERAL_TRACK_DETAILS_END])


def build_num_devices_body(device_count: int) -> List[int]:
    return build_sysex_body([PLUGIN_TYPE, PLUGIN_NUM_DEVICES, device_count & 0x7F])


def build_first_device_body(first_device_index: int) -> List[int]:
    return build_sysex_body([PLUGIN_TYPE, PLUGIN_FIRST_DEVICE, first_device_index & 0x7F])


def build_plugin_details_body(plugin: DemoPlugin) -> List[int]:
    return build_sysex_body(
        [
            PLUGIN_TYPE,
            PLUGIN_DEVICE_DETAILS,
            plugin.index & 0x7F,
            *stable_hash_8(plugin.plugin_hash_source),
            0x01 if plugin.enabled else 0x00,
            *to_ascii_0d(plugin.name),
            plugin.plugin_type & 0x7F,
            plugin.page_count & 0x7F,
        ]
    )


def build_plugin_details_end_body() -> List[int]:
    return build_sysex_body([PLUGIN_TYPE, PLUGIN_DEVICE_DETAILS_END])


def build_plugin_selection_body(plugin_index: int, page_index: int = 0, force_plugin: bool = False) -> List[int]:
    return build_sysex_body(
        [PLUGIN_TYPE, PLUGIN_DAW_SELECT_PLUGIN, plugin_index & 0x7F, page_index & 0x7F, 0x01 if force_plugin else 0x00]
    )


def build_learn_param_body(slot: DemoSlot, absolute_slot_index: int) -> List[int]:
    parameter_index = u14_to_pair(absolute_slot_index)
    macro_param = 0x00
    centered = 0x01 if slot.centered else 0x00
    quantized_steps = max(0, min(18, int(slot.quantized_step_count)))
    if centered:
        quantized_steps = 0
    payload = [
        PLUGIN_TYPE,
        PLUGIN_LEARN_PARAM,
        *parameter_index,
        *stable_hash_6(slot.id),
        macro_param,
        centered,
        quantized_steps & 0x7F,
        *u14_to_pair(normalized_to_u14(slot.normalized_value)),
        *to_ascii_0d(slot.label),
    ]
    if 0 < quantized_steps <= 10 and slot.enum_labels:
        for label in list(slot.enum_labels)[:quantized_steps]:
            payload.extend(to_ascii_0d(label))
    return build_sysex_body(payload)


def build_plugin_name_change_body(slot: DemoSlot, absolute_slot_index: int, name: Optional[str] = None) -> List[int]:
    display_name = slot.label if name is None else name
    return build_sysex_body(
        [
            PLUGIN_TYPE,
            PLUGIN_SET_MAPPED_CONTROL_NAME,
            0x00,
            (absolute_slot_index + 1) & 0x7F,
            *stable_hash_6(slot.id),
            *to_ascii_0d(display_name),
        ]
    )


def build_request_api_version_body() -> List[int]:
    return build_sysex_body([GENERAL_TYPE, GENERAL_REQUEST_API_VERSION])


def build_knob_hires_cc_messages(absolute_slot_index: int, normalized_value: Optional[float]) -> List[List[int]]:
    cc_base = 0x0C + absolute_slot_index
    u14_value = normalized_to_u14(normalized_value)
    high, low = u14_to_pair(u14_value)
    return [
        [0xBF, cc_base & 0x7F, high & 0x7F],
        [0xBF, (cc_base + 0x20) & 0x7F, low & 0x7F],
    ]


def build_knob_touch_message(absolute_slot_index: int, touched: bool) -> List[int]:
    return [0xBF, (0x34 + absolute_slot_index) & 0x7F, 0x7F if touched else 0x00]


def build_demo_plugin() -> DemoPlugin:
    slots = build_demo_slots()
    return DemoPlugin(
        index=0,
        name="Simularca",
        plugin_hash_source="SimularcaDemoPlugin",
        enabled=True,
        plugin_type=2,
        page_count=1,
        slots=tuple(slots),
    )


def make_serial_request(command: int, subcommand: int, payload: Sequence[int] | bytes = ()) -> bytes:
    payload_bytes = bytes(int(value) & 0xFF for value in payload)
    payload_length = len(payload_bytes)
    return bytes(
        [
            SERIAL_MESSAGE_COMMAND,
            command & 0xFF,
            subcommand & 0xFF,
            (payload_length >> 8) & 0xFF,
            payload_length & 0xFF,
            *payload_bytes,
        ]
    )


def parse_serial_version_payload(payload: bytes) -> dict:
    if len(payload) != 10:
        raise ValueError(f"Expected 10 bytes of version payload, got {len(payload)}.")
    return {
        "major": payload[0],
        "minor": payload[1],
        "patch": payload[2],
        "commit": payload[3:].decode("utf-8", errors="ignore").replace("\x00", ""),
    }


def parse_serial_mode_payload(payload: bytes) -> dict:
    if len(payload) != 2:
        raise ValueError(f"Expected 2 bytes of mode payload, got {len(payload)}.")
    mode_index = payload[0]
    return {
        "mode_index": mode_index,
        "mode": SERIAL_MODE_NAMES[mode_index] if 0 <= mode_index < len(SERIAL_MODE_NAMES) else f"UNKNOWN({mode_index})",
        "first_visible_control_index": payload[1],
    }


def parse_serial_plugin_payload(payload: bytes, include_daw_type: bool = False) -> dict:
    expected = 23 if include_daw_type else 22
    if len(payload) != expected:
        raise ValueError(f"Expected {expected} bytes of plugin payload, got {len(payload)}.")
    result = {
        "plugin_hash": bytes_to_hex(payload[:8]),
        "plugin_name": payload[8:21].decode("utf-8", errors="ignore").replace("\x00", ""),
        "plugin_type": payload[21],
    }
    if include_daw_type:
        result["daw_type"] = payload[22]
    return result


def build_serial_get_version_request() -> bytes:
    return make_serial_request(SERIAL_GENERAL, SERIAL_GENERAL_GET_FW_VERSION)


def build_serial_get_mode_request() -> bytes:
    return make_serial_request(SERIAL_GENERAL, SERIAL_GENERAL_GET_MODE)


def build_serial_set_mode_request(mode_name: str, first_visible_control_index: int = 0) -> bytes:
    mode_index = SERIAL_MODE_NAMES.index(mode_name.upper())
    return make_serial_request(SERIAL_GENERAL, SERIAL_GENERAL_SET_MODE, [mode_index, first_visible_control_index & 0xFF])


def build_serial_start_config_update_request() -> bytes:
    return make_serial_request(SERIAL_GENERAL, SERIAL_GENERAL_START_CONFIG_UPDATE)


def build_serial_end_config_update_request() -> bytes:
    return make_serial_request(SERIAL_GENERAL, SERIAL_GENERAL_END_CONFIG_UPDATE)


def build_serial_plugin_get_current_request() -> bytes:
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_GET_CURRENT_PLUGIN)


def build_serial_plugin_get_first_request() -> bytes:
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_GET_FIRST_PLUGIN)


def build_serial_plugin_get_next_request() -> bytes:
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_GET_NEXT_PLUGIN)


def build_serial_plugin_add_request(plugin: DemoPlugin) -> bytes:
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_ADD_PLUGIN, [*stable_hash_8(plugin.plugin_hash_source), *to_ascii_0d(plugin.name)])


def build_serial_plugin_set_name_request(plugin: DemoPlugin) -> bytes:
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_SET_PLUGIN_NAME, [*stable_hash_8(plugin.plugin_hash_source), *to_ascii_0d(plugin.name)])


def build_serial_plugin_get_knob_config_request(plugin: DemoPlugin, control_index: int) -> bytes:
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_GET_KNOB_CONFIG, [*stable_hash_8(plugin.plugin_hash_source), control_index & 0xFF])


def build_serial_plugin_set_knob_config_request(plugin: DemoPlugin, config: SerialPluginKnobConfig) -> bytes:
    payload = [
        *stable_hash_8(plugin.plugin_hash_source),
        config.control_index & 0xFF,
        (config.mapped_param >> 8) & 0xFF,
        config.mapped_param & 0xFF,
        *(int(value) & 0x7F for value in config.param_hash[:6]),
        0x01 if config.macro_param else 0x00,
        (config.min_value >> 8) & 0xFF,
        config.min_value & 0xFF,
        (config.max_value >> 8) & 0xFF,
        config.max_value & 0xFF,
        *to_ascii_0d(config.control_name),
        config.color_scheme & 0xFF,
        config.haptic_mode & 0xFF,
        config.haptic_indent_1 & 0xFF,
        config.haptic_indent_2 & 0xFF,
        config.haptic_steps & 0xFF,
    ]
    step_names = list(config.step_names)[:16]
    for index in range(16):
        payload.extend(to_ascii_0d(step_names[index] if index < len(step_names) else ""))
    return make_serial_request(SERIAL_PLUGIN, SERIAL_PLUGIN_SET_KNOB_CONFIG, payload)


def build_demo_serial_knob_configs(plugin: DemoPlugin) -> List[SerialPluginKnobConfig]:
    configs: List[SerialPluginKnobConfig] = []
    for index, slot in enumerate(plugin.slots):
        step_names = tuple(slot.enum_labels[:16]) if slot.enum_labels else tuple()
        haptic_steps = min(16, slot.quantized_step_count) if slot.quantized_step_count > 0 else 0
        configs.append(
            SerialPluginKnobConfig(
                control_index=index,
                mapped_param=index,
                param_hash=stable_hash_6(slot.id),
                macro_param=False,
                min_value=0,
                max_value=16383,
                control_name=slot.label,
                color_scheme=0,
                haptic_mode=0,
                haptic_indent_1=0x40 if slot.centered else 0xFF,
                haptic_indent_2=0xFF,
                haptic_steps=haptic_steps,
                step_names=step_names,
            )
        )
    return configs


def build_demo_slots() -> List[DemoSlot]:
    return [
        DemoSlot(id="demo.1", label="TEST 1", normalized_value=0.5),
        DemoSlot(id="demo.2", label="TEST 2", normalized_value=0.75),
        DemoSlot(id="demo.3", label="SWITCH", normalized_value=1.0, quantized_step_count=2, enum_labels=("Off", "On")),
        DemoSlot(id="demo.4", label="CHOICE", normalized_value=0.5, quantized_step_count=3, enum_labels=("A", "B", "C")),
        DemoSlot(id="demo.5", label="CENTER", normalized_value=0.5, centered=True),
        DemoSlot(id="demo.6", label="LEVEL", normalized_value=0.25),
        DemoSlot(id="demo.7", label="COLOR", normalized_value=0.9),
        DemoSlot(id="demo.8", label="VALUE", normalized_value=0.1),
    ]
