import type { PluginHandshakeModule } from "./contracts";
import { createBeamCrossoverPlugin } from "./beamPlugin";

export { beamEmitterArrayDescriptor, beamEmitterDescriptor } from "./beamPlugin";
export {
  buildBeamGeometryWorld,
  buildCombinedBeamGeometryWorld,
  computeSilhouetteWorld,
  sampleArcLengthCurveTs
} from "./math";

const handshake: PluginHandshakeModule = {
  manifest: {
    handshakeVersion: 1,
    id: "beam.crossover",
    name: "Beam Crossover",
    version: "0.1.0",
    description: "Volumetric beam emitters that analytically target primitive silhouettes.",
    engine: {
      minApiVersion: 1,
      maxApiVersion: 1
    }
  },
  createPlugin() {
    return createBeamCrossoverPlugin();
  }
};

export { handshake };
export default handshake;
