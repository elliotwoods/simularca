from __future__ import annotations

from typing import Dict, List

from .protocol import (
    build_demo_plugin,
    build_connected_ack_body,
    GENERAL_API_VERSION,
    GENERAL_CONNECTED,
    GENERAL_TYPE,
    GENERAL_PING_DAW,
    build_daw_started_body,
    build_first_device_body,
    build_first_track_body,
    build_knob_hires_cc_messages,
    build_knob_touch_message,
    build_learn_param_body,
    build_num_devices_body,
    build_num_tracks_body,
    build_ping_response_body,
    build_plugin_details_body,
    build_plugin_details_end_body,
    build_plugin_name_change_body,
    build_plugin_selection_body,
    build_track_details_body,
    build_track_details_end_body,
    PLUGIN_DAW_SELECT_PLUGIN,
    PLUGIN_SET_MODE,
    PLUGIN_TYPE,
)


def perform_handshake(session, logger, daw_emulation: str, timeout_seconds: float) -> Dict[str, object]:
    logger.info("Sending DAW STARTED using %s emulation.", daw_emulation)
    session.send_sysex_body(build_daw_started_body())
    _ping_event, _ping_payload = session.wait_for_roto_sysex(GENERAL_PING_DAW, timeout_seconds)
    logger.info("Received PING DAW from controller.")
    session.send_sysex_body(build_ping_response_body(daw_emulation))
    logger.info("Sent PING RESPONSE for %s.", daw_emulation)
    _connected_event, _connected_payload = session.wait_for_roto_sysex(GENERAL_CONNECTED, timeout_seconds)
    logger.info("Received ROTO-DAW CONNECTED.")
    session.send_sysex_body(build_connected_ack_body())
    logger.info("Sent post-connect acknowledgement.")
    return {
        "connected": True,
        "daw_emulation": daw_emulation,
    }


def _publish_plugin_inventory(session, logger) -> Dict[str, object]:
    plugin = build_demo_plugin()
    session.send_sysex_body(build_num_tracks_body(1))
    session.send_sysex_body(build_first_track_body(0))
    session.send_sysex_body(build_track_details_body(0, "Simularca"))
    session.send_sysex_body(build_track_details_end_body())
    logger.info("Published minimal track inventory.")

    session.send_sysex_body(build_num_devices_body(1))
    session.send_sysex_body(build_first_device_body(0))
    session.send_sysex_body(build_plugin_details_body(plugin))
    session.send_sysex_body(build_plugin_details_end_body())
    session.send_sysex_body(build_plugin_selection_body(plugin.index, 0, False))
    logger.info("Published plugin inventory and selected plugin '%s'.", plugin.name)
    return {
        "plugin_name": plugin.name,
        "plugin_index": plugin.index,
        "plugin_hash_source": plugin.plugin_hash_source,
        "slot_labels": [slot.label for slot in plugin.slots],
    }


def publish_demo_bank(session, logger) -> Dict[str, object]:
    plugin_mode_data = None
    selected_plugin_request = None
    try:
        _request_event, request_payload = session.wait_for_roto_message(PLUGIN_TYPE, PLUGIN_SET_MODE, 1.0)
        plugin_mode_data = request_payload["body"][2:]
        logger.info("Received PLUGIN mode request with payload %s.", plugin_mode_data)
    except TimeoutError:
        logger.info("No explicit PLUGIN mode request arrived before demo publish; proceeding anyway.")

    inventory = _publish_plugin_inventory(session, logger)

    try:
        _request_event, request_payload = session.wait_for_roto_message(PLUGIN_TYPE, PLUGIN_DAW_SELECT_PLUGIN, 0.5)
        selected_plugin_request = request_payload["body"][2:]
        logger.info("Received plugin selection echo/request with payload %s.", selected_plugin_request)
    except TimeoutError:
        logger.info("No DAW_SELECT_PLUGIN request arrived after inventory publish.")

    for index, slot in enumerate(build_demo_plugin().slots):
        body = build_learn_param_body(slot, index)
        session.send_sysex_body(body)
        logger.info("Published slot %s -> %s", index + 1, slot.label)
    return {
        "title": "DEMO BANK",
        "slot_count": len(inventory["slot_labels"]),
        "plugin_mode_data": plugin_mode_data,
        "selected_plugin_request": selected_plugin_request,
        **inventory,
    }


def probe_plugin_displays(session, logger, dwell_seconds: float = 0.2) -> Dict[str, object]:
    import time

    plugin = build_demo_plugin()
    api_version_payloads: List[List[int]] = []
    sent_names: List[str] = []

    for index, slot in enumerate(plugin.slots):
        for cc_message in build_knob_hires_cc_messages(index, slot.normalized_value):
            session.send_raw(cc_message)
        session.send_raw(build_knob_touch_message(index, True))
        name_text = f"{slot.label[:8]} {index + 1}".strip()
        session.send_sysex_body(build_plugin_name_change_body(slot, index, name_text))
        sent_names.append(name_text)
        try:
            _event, payload = session.wait_for_roto_message(GENERAL_TYPE, GENERAL_API_VERSION, 0.1)
            api_version_payloads.append(payload["body"][2:])
            logger.info("Unexpected API version response during display probe slot %s: %s.", index + 1, payload["body"][2:])
        except TimeoutError:
            logger.info("Display probe slot %s produced no direct SysEx response, which is expected for name-only updates.", index + 1)
        if dwell_seconds > 0:
            time.sleep(dwell_seconds)
        session.send_raw(build_knob_touch_message(index, False))
        time.sleep(0.05)

    return {
        "slot_count": len(plugin.slots),
        "sent_names": sent_names,
        "api_version_response_count": len(api_version_payloads),
        "api_version_payloads": api_version_payloads,
    }
