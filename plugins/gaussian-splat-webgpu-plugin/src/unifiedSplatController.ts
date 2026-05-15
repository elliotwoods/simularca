import * as THREE from "three";
import { SplatController as WebGpuSplatController } from "./splatController";
import { SparkSplatController } from "./sparkSplatController";

interface SyncContext {
  actor: { id: string; params: Record<string, unknown> };
  state: unknown;
  object: unknown;
  profileChunk?<T>(label: string, run: () => T): T;
  setActorStatus(status: unknown): void;
  readAssetBytes(assetId: string): Promise<Uint8Array>;
}

type ActiveBackend = "webgpu" | "webgl2";

interface BackendController {
  sync(context: SyncContext): void;
  dispose(): void;
}

function readRenderEngine(state: unknown): ActiveBackend {
  if (!state || typeof state !== "object") {
    return "webgl2";
  }
  const renderEngine = (state as { scene?: { renderEngine?: unknown } }).scene?.renderEngine;
  return renderEngine === "webgpu" ? "webgpu" : "webgl2";
}

export class UnifiedSplatController {
  private activeBackend: ActiveBackend | null = null;
  private activeController: BackendController | null = null;

  public constructor(private readonly renderRoot: THREE.Group) {}

  public sync(context: SyncContext): void {
    const nextBackend = readRenderEngine(context.state);
    if (this.activeBackend !== nextBackend || !this.activeController) {
      this.activeController?.dispose();
      this.activeController = nextBackend === "webgpu"
        ? new WebGpuSplatController(this.renderRoot)
        : new SparkSplatController(this.renderRoot);
      this.activeBackend = nextBackend;
    }
    this.activeController.sync(context);
  }

  public dispose(): void {
    this.activeController?.dispose();
    this.activeController = null;
    this.activeBackend = null;
  }
}
