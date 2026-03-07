import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import { CURVE_VERTEX_SELECT_EVENT } from "@/render/curveEditController";
import type { SceneController } from "@/render/sceneController";

export type ActorTransformMode = "translate" | "rotate";

interface CurveVertexSelectionDetail {
  actorId?: string | null;
}

export class ActorTransformController {
  private readonly transformControls: any;
  private readonly transformHelper: THREE.Object3D;
  private mode: ActorTransformMode = "translate";
  private activeActorId: string | null = null;
  private activeSignature = "";
  private dragHistoryPushed = false;
  private activeCurveControlActorId: string | null = null;

  public constructor(
    private readonly kernel: AppKernel,
    private readonly sceneController: SceneController,
    private readonly orbitControls: OrbitControls,
    domElement: HTMLElement,
    initialCamera: THREE.Camera
  ) {
    this.transformControls = new TransformControls(initialCamera, domElement);
    this.transformControls.setMode(this.mode);
    this.transformControls.space = "world";
    this.transformControls.size = 1.05;
    this.transformHelper =
      typeof this.transformControls.getHelper === "function" ? this.transformControls.getHelper() : this.transformControls;

    this.transformControls.addEventListener("dragging-changed" as any, (event: { value?: boolean }) => {
      const dragging = Boolean(event.value);
      (this.orbitControls as any).enabled = !dragging;
      if (dragging && !this.dragHistoryPushed && this.activeActorId) {
        this.kernel.store.getState().actions.pushHistory("Transform actor");
        this.dragHistoryPushed = true;
      }
      if (!dragging) {
        this.dragHistoryPushed = false;
      }
    });

    this.transformControls.addEventListener("objectChange" as any, () => {
      this.applyTransformChange();
    });

    this.sceneController.scene.add(this.transformHelper);
    window.addEventListener(CURVE_VERTEX_SELECT_EVENT, this.onCurveVertexSelect as EventListener);
  }

  public dispose(): void {
    window.removeEventListener(CURVE_VERTEX_SELECT_EVENT, this.onCurveVertexSelect as EventListener);
    this.transformControls.detach();
    this.transformControls.dispose();
    this.transformHelper.parent?.remove(this.transformHelper);
    this.activeActorId = null;
    this.activeSignature = "";
    this.activeCurveControlActorId = null;
    this.dragHistoryPushed = false;
    (this.orbitControls as any).enabled = true;
  }

  public setCamera(camera: THREE.Camera): void {
    this.transformControls.camera = camera;
  }

  public setMode(mode: ActorTransformMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.transformControls.setMode(mode);
    this.transformControls.space = mode === "translate" ? "world" : "local";
  }

  public update(): void {
    const state = this.kernel.store.getState().state;
    if (state.mode === "web-ro") {
      this.hideControls();
      return;
    }
    const selectedActor = this.getSingleSelectedActor();
    if (!selectedActor) {
      this.hideControls();
      return;
    }
    if (selectedActor.actorType === "curve" && this.activeCurveControlActorId === selectedActor.id) {
      this.hideControls(false);
      return;
    }

    const actorObject = this.sceneController.getActorObject(selectedActor.id);
    if (!(actorObject instanceof THREE.Object3D)) {
      this.hideControls();
      return;
    }

    const signature = JSON.stringify({
      actorId: selectedActor.id,
      mode: this.mode,
      position: selectedActor.transform.position,
      rotation: selectedActor.transform.rotation,
      scale: selectedActor.transform.scale
    });

    if (this.activeActorId !== selectedActor.id || this.activeSignature !== signature) {
      this.activeActorId = selectedActor.id;
      this.activeSignature = signature;
      this.transformControls.detach();
      this.transformControls.attach(actorObject);
      this.syncAttachedObjectTransform(selectedActor.id);
      return;
    }

    if (this.transformControls.object !== actorObject) {
      this.transformControls.detach();
      this.transformControls.attach(actorObject);
    }
  }

  private getSingleSelectedActor() {
    const state = this.kernel.store.getState().state;
    if (state.selection.length !== 1 || state.selection[0]?.kind !== "actor") {
      return null;
    }
    return state.actors[state.selection[0].id] ?? null;
  }

  private hideControls(clearActorId = true): void {
    this.transformControls.detach();
    if (clearActorId) {
      this.activeActorId = null;
      this.activeSignature = "";
    }
    this.dragHistoryPushed = false;
    (this.orbitControls as any).enabled = true;
  }

  private syncAttachedObjectTransform(actorId: string): void {
    const object = this.transformControls.object;
    const actor = this.kernel.store.getState().state.actors[actorId];
    if (!object || !actor) {
      return;
    }
    object.position.set(...actor.transform.position);
    object.rotation.set(...actor.transform.rotation);
    object.scale.set(...actor.transform.scale);
    object.updateMatrixWorld();
  }

  private applyTransformChange(): void {
    if (!this.activeActorId || !this.transformControls.object) {
      return;
    }
    const object = this.transformControls.object;
    const actions = this.kernel.store.getState().actions;
    actions.setActorTransformNoHistory(this.activeActorId, "position", [
      object.position.x,
      object.position.y,
      object.position.z
    ]);
    actions.setActorTransformNoHistory(this.activeActorId, "rotation", [
      object.rotation.x,
      object.rotation.y,
      object.rotation.z
    ]);
  }

  private onCurveVertexSelect = (event: Event): void => {
    const custom = event as CustomEvent<CurveVertexSelectionDetail>;
    const actorId = custom.detail?.actorId ?? null;
    this.activeCurveControlActorId = actorId;
    if (this.activeActorId && actorId === this.activeActorId) {
      this.hideControls(false);
      return;
    }
    const selectedActor = this.getSingleSelectedActor();
    if (selectedActor && selectedActor.id === this.activeActorId && actorId === null) {
      this.activeSignature = "";
    }
  };
}
