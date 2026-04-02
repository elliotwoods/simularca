import unittest

from roto_control_sanity.protocol import (
    GENERAL_CONNECTED,
    GENERAL_CONNECTED_ACK,
    GENERAL_REQUEST_API_VERSION,
    GENERAL_FIRST_TRACK,
    GENERAL_NUM_TRACKS,
    GENERAL_PING_DAW,
    GENERAL_TRACK_DETAILS,
    PLUGIN_DAW_SELECT_PLUGIN,
    PLUGIN_DEVICE_DETAILS,
    PLUGIN_DEVICE_DETAILS_END,
    PLUGIN_FIRST_DEVICE,
    PLUGIN_SET_MAPPED_CONTROL_NAME,
    PLUGIN_NUM_DEVICES,
    build_daw_started_body,
    build_connected_ack_body,
    build_demo_plugin,
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
    build_request_api_version_body,
    build_track_details_body,
    is_roto_sysex,
    parse_roto_sysex,
    shorten_label,
    to_ascii_0d,
    u14_to_pair,
    DemoSlot,
)


class ProtocolTests(unittest.TestCase):
    def test_u14_pair_encoding(self) -> None:
        self.assertEqual(u14_to_pair(0), [0, 0])
        self.assertEqual(u14_to_pair(16383), [127, 127])
        self.assertEqual(u14_to_pair(128), [1, 0])

    def test_shorten_label(self) -> None:
        self.assertEqual(shorten_label("Camera Navigation Speed", 12), "Came Nav Spe")
        self.assertEqual(shorten_label("Translate X", 12), "Transl X")
        self.assertEqual(shorten_label("TEST 1", 12), "TEST 1")

    def test_ascii_0d(self) -> None:
        encoded = to_ascii_0d("TEST 123")
        self.assertEqual(len(encoded), 13)
        self.assertEqual(encoded[0], ord("T"))
        self.assertEqual(encoded[8], 0)

    def test_handshake_messages(self) -> None:
        self.assertEqual(build_daw_started_body(), [0x00, 0x22, 0x03, 0x02, 0x0A, 0x01])
        self.assertEqual(build_ping_response_body("ableton"), [0x00, 0x22, 0x03, 0x02, 0x0A, 0x03, 0x01])
        self.assertEqual(build_ping_response_body("bitwig"), [0x00, 0x22, 0x03, 0x02, 0x0A, 0x03, 0x02])
        self.assertEqual(build_connected_ack_body(), [0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_CONNECTED_ACK])

    def test_plugin_inventory_messages(self) -> None:
        plugin = build_demo_plugin()
        self.assertEqual(build_num_tracks_body(1), [0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_NUM_TRACKS, 0x00, 0x01])
        self.assertEqual(build_first_track_body(0), [0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_FIRST_TRACK, 0x00, 0x00])
        track_details = build_track_details_body(0, "Simularca")
        self.assertEqual(track_details[:6], [0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_TRACK_DETAILS])
        self.assertEqual(build_num_devices_body(1), [0x00, 0x22, 0x03, 0x02, 0x0B, PLUGIN_NUM_DEVICES, 0x01])
        self.assertEqual(build_first_device_body(0), [0x00, 0x22, 0x03, 0x02, 0x0B, PLUGIN_FIRST_DEVICE, 0x00])
        plugin_details = build_plugin_details_body(plugin)
        self.assertEqual(plugin_details[:6], [0x00, 0x22, 0x03, 0x02, 0x0B, PLUGIN_DEVICE_DETAILS])
        self.assertEqual(build_plugin_details_end_body(), [0x00, 0x22, 0x03, 0x02, 0x0B, PLUGIN_DEVICE_DETAILS_END])
        self.assertEqual(
            build_plugin_selection_body(0, 0, False),
            [0x00, 0x22, 0x03, 0x02, 0x0B, PLUGIN_DAW_SELECT_PLUGIN, 0x00, 0x00, 0x00],
        )

    def test_parse_roto_sysex(self) -> None:
        payload = [0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_PING_DAW]
        self.assertTrue(is_roto_sysex(payload))
        parsed = parse_roto_sysex(payload)
        self.assertIsNotNone(parsed)
        self.assertEqual(parsed["sub_type"], GENERAL_PING_DAW)

    def test_build_learn_param_body(self) -> None:
        body = build_learn_param_body(
            DemoSlot(
                id="demo.choice",
                label="Choice",
                normalized_value=0.5,
                quantized_step_count=3,
                enum_labels=("A", "B", "C"),
            ),
            9,
        )
        self.assertEqual(body[:6], [0x00, 0x22, 0x03, 0x02, 0x0B, 0x0A])
        self.assertEqual(body[6:8], [0x00, 0x09])

    def test_parse_connected(self) -> None:
        parsed = parse_roto_sysex([0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_CONNECTED])
        self.assertEqual(parsed["sub_type"], GENERAL_CONNECTED)

    def test_display_probe_messages(self) -> None:
        slot = DemoSlot(id="simularca.slot.0", label="Alpha", normalized_value=0.5)
        name_change = build_plugin_name_change_body(slot, 0)
        self.assertEqual(name_change[:6], [0x00, 0x22, 0x03, 0x02, 0x0B, PLUGIN_SET_MAPPED_CONTROL_NAME])
        self.assertEqual(name_change[6:8], [0x00, 0x01])

        api_version_request = build_request_api_version_body()
        self.assertEqual(api_version_request, [0x00, 0x22, 0x03, 0x02, 0x0A, GENERAL_REQUEST_API_VERSION])

        cc_messages = build_knob_hires_cc_messages(0, 0.5)
        self.assertEqual(len(cc_messages), 2)
        self.assertEqual(cc_messages[0][:2], [0xBF, 0x0C])
        self.assertEqual(cc_messages[1][:2], [0xBF, 0x2C])
        self.assertEqual(build_knob_touch_message(0, True), [0xBF, 0x34, 0x7F])
        self.assertEqual(build_knob_touch_message(0, False), [0xBF, 0x34, 0x00])


if __name__ == "__main__":
    unittest.main()
