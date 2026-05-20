import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { AppKernel } from "@/app/kernel";
import { CURVE_VERTEX_SELECT_EVENT } from "@/render/curveEditController";
import type { SceneController } from "@/render/sceneController";

export type ActorTransformMode = "none" | "translate" | "rotate" | "scale";
const ACTOR_TRANSLATION_SNAP = 0.1;
const ACTOR_ROTATION_SNAP_RADIANS = Math.PI / 12;
const ACTOR_SCALE_SNAP = 0.1;

interface CurveVertexSelectionDetail {
  actorId?: string | null;
  pointIndex?: number | null;
  controlType?: string;
}

export class ActorTransformController {
  private readonly transformControls: any;
  private readonly transformHelper: THREE.Object3D;
  private readonly domElement: HTMLElement;
  private mode: ActorTransformMode = "none";
  private snappingEnabled = true;
  private activeActorId: string | null = null;
  private activeSignature = "";
  private dragHistoryPushed = false;
  private activeCurveSelection: CurveVertexSelectionDetail | null = null;
  private pendingOrbitBlock = false;

  public constructor(
    private readonly kernel: AppKernel,
    private readonly sceneController: SceneController,
    private readonly orbitControls: OrbitControls,
    domElement: HTMLElement,
    initialCamera: THREE.Camera
  ) {
    this.domElement = domElement;
    this.transformControls = new TransformControls(initialCamera, domElement);
    this.transformControls.setMode("translate");
    this.transformControls.space = "world";
    this.transformControls.size = 1.05;
    this.applySnapState();
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

    this.domElement.addEventListener("pointerdown", this.onPointerDownCapture, true);
    this.domElement.addEventListener("pointerup", this.onPointerUpCapture, true);
    window.addEventListener(CURVE_VERTEX_SELECT_EVENT, this.onCurveVertexSelect as EventListener);
  }

  /**
   * Show or hide the transform gizmo. Used by the viewport's coordinated
   * `setEditorHelpersVisible(...)` so that hiding helpers (e.g. during a
   * "clean" screenshot or video render) also hides the active transform
   * controls. This is a hard override: the controller's attach/detach
   * logic re-sets `transformHelper.visible` on the next selection change,
   * so callers that flip this off should restore it explicitly when done.
   */
  public setVisible(visible: boolean): void {
    this.transformHelper.visible = visible;
  }

  public getVisible(): boolean {
    return this.transformHelper.visible;
  }

  public dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDownCapture, true);
    this.domElement.removeEventListener("pointerup", this.onPointerUpCapture, true);
    window.removeEventListener(CURVE_VERTEX_SELECT_EVENT, this.onCurveVertexSelect as EventListener);
    this.transformControls.detach();
    this.transformControls.dispose();
    this.transformHelper.parent?.remove(this.transformHelper);
    this.activeActorId = null;
    this.activeSignature = "";
    this.activeCurveSelection = null;
    this.dragHistoryPushed = false;
    this.pendingOrbitBlock = false;
    (this.orbitControls as any).enabled = true;
  }

  public setCamera(camera: THREE.Camera): void {
    this.transformControls.camera = camera;
  }

  public willHandlePointerDown(event: PointerEvent): boolean {
    return this.claimsPointerDown(event);
  }

  private claimsPointerDown(event: PointerEvent): boolean {
    if (event.button !== 0 || !this.transformControls.object || this.mode === "none") {
      return false;
    }
    if (this.transformControls.dragging) {
      return true;
    }
    if (this.activeActorId && this.hasActiveCurveControlSelectionFor(this.activeActorId)) {
      return false;
    }
    const pointer = this.pointerToNdc(event);
    if (!pointer) {
      return false;
    }
    this.transformControls.pointerHover(pointer);
    return Boolean(this.transformControls.axis);
  }

  public setMode(mode: ActorTransformMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    if (mode !== "none") {
      this.transformControls.setMode(mode);
      this.transformControls.space = mode === "translate" ? "world" : "local";
    }
    this.applySnapState();
    this.activeSignature = "";
  }

  public setSnappingEnabled(enabled: boolean): void {
    if (this.snappingEnabled === enabled) {
      return;
    }
    this.snappingEnabled = enabled;
    this.applySnapState();
  }

  public update(): void {
    if (this.transformControls.dragging) {
      return;
    }
    const state = this.kernel.store.getState().state;
    if (state.mode === "web-ro") {
      this.hideControls();
      return;
    }
    if (this.mode === "none") {
      this.hideControls();
      return;
    }
    const selectedActor = this.getSingleSelectedActor();
    if (!selectedActor) {
      this.hideControls();
      return;
    }
    if (this.hasActiveCurveControlSelectionFor(selectedActor.id)) {
      this.hideControls(false);
      return;
    }

    const actorObject = this.sceneController.getActorObject(selectedActor.id);
    if (!(actorObject instanceof THREE.Object3D)) {
      this.hideControls();
      return;
    }
    this.ensureTransformHelperAttached();

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
    this.transformHelper.parent?.remove(this.transformHelper);
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
    const nextScale: [number, number, number] = [
      Math.max(0, object.scale.x),
      Math.max(0, object.scale.y),
      Math.max(0, object.scale.z)
    ];
    object.scale.set(...nextScale);
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
    actions.setActorTransformNoHistory(this.activeActorId, "scale", nextScale);
  }

  private applySnapState(): void {
    this.transformControls.translationSnap = this.mode === "translate" && this.snappingEnabled ? ACTOR_TRANSLATION_SNAP : null;
    this.transformControls.rotationSnap =
      this.mode === "rotate" && this.snappingEnabled ? ACTOR_ROTATION_SNAP_RADIANS : null;
    this.transformControls.scaleSnap = this.mode === "scale" && this.snappingEnabled ? ACTOR_SCALE_SNAP : null;
  }

  private pointerToNdc(event: PointerEvent): { x: number; y: number; button: number } | null {
    const rect = this.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    return {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
      button: event.button
    };
  }

  private onPointerDownCapture = (event: PointerEvent): void => {
    if (event.button !== 0 || !this.transformControls.object || this.mode === "none") {
      return;
    }
    if (this.activeActorId && this.hasActiveCurveControlSelectionFor(this.activeActorId)) {
      return;
    }
    const pointer = this.pointerToNdc(event);
    if (!pointer) {
      return;
    }
    this.transformControls.pointerHover(pointer);
    if (!this.transformControls.axis) {
      return;
    }
    this.pendingOrbitBlock = true;
    (this.orbitControls as any).enabled = false;
  };

  private onPointerUpCapture = (): void => {
    if (!this.pendingOrbitBlock) {
      return;
    }
    this.pendingOrbitBlock = false;
    if (!this.transformControls.dragging) {
      (this.orbitControls as any).enabled = true;
    }
  };

  private onCurveVertexSelect = (event: Event): void => {
    const custom = event as CustomEvent<CurveVertexSelectionDetail>;
    const actorId = custom.detail?.actorId ?? null;
    const pointIndex = custom.detail?.pointIndex;
    this.activeCurveSelection =
      actorId && typeof pointIndex === "number" && pointIndex >= 0
        ? {
            actorId,
            pointIndex,
            controlType: custom.detail?.controlType
          }
        : null;
    if (this.activeActorId && this.hasActiveCurveControlSelectionFor(this.activeActorId)) {
      this.hideControls(false);
      return;
    }
    const selectedActor = this.getSingleSelectedActor();
    if (selectedActor && selectedActor.id === this.activeActorId && actorId === null) {
      this.activeSignature = "";
    }
  };

  private hasActiveCurveControlSelectionFor(actorId: string): boolean {
    return this.activeCurveSelection?.actorId === actorId && typeof this.activeCurveSelection.pointIndex === "number";
  }

  private ensureTransformHelperAttached(): void {
    if (this.transformHelper.parent === this.sceneController.scene) {
      return;
    }
    this.transformHelper.parent?.remove(this.transformHelper);
    this.sceneController.scene.add(this.transformHelper);
  }
}
