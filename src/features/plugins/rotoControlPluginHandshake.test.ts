import { describe, expect, it } from "vitest";
import handshake from "../../../plugins/roto-control-plugin/src/index";
import { PLUGIN_VERSION } from "../../../plugins/roto-control-plugin/src/pluginBuildInfo.generated";
import { isPluginHandshakeModule } from "@/features/plugins/contracts";

describe("roto-control plugin handshake", () => {
  it("exports a valid handshake with the generated plugin version", () => {
    expect(isPluginHandshakeModule(handshake)).toBe(true);
    expect(handshake.manifest.id).toBe("plugin.rotoControl");
    expect(handshake.manifest.name).toBe("Roto-Control");
    expect(handshake.manifest.version).toBe(PLUGIN_VERSION);
    expect(handshake.manifest.version).not.toBe("internal");
  });
});
