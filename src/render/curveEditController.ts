import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { keyboardCommandRouter } from "@/app/keyboardCommandRouter";
import type { AppKernel } from "@/app/kernel";
import type { ActorNode } from "@/core/types";
import { getEffectiveCurveHandlesAt } from "@/features/curves/handles";
import { setCurveAnchorPosition, setCurveHandlePosition, appendCurvePoint } from "@/features/curves/editing";
import { curveDataWithOverrides, getCurveTypeFromActor } from "@/features/curves/model";
import type { CurvePoint } from "@/features/curves/types";
import type { SceneController } from "@/render/sceneController";

type CurveControlType = "anchor" | "handleIn" | "handleOut";
export const CURVE_VERTEX_HOVER_EVENT = "simularca:curve-vertex-hover";
export const CURVE_VERTEX_SELECT_EVENT = "simularca:curve-vertex-select";

interface CurveControlMeta {
  actorId: string;
  pointIndex: number;
  controlType: CurveControlType;
}

interface CurvePointVisual {
  anchor: any;
  handleIn: any;
  handleOut: any;
  lineIn: any;
  lineOut: any;
}

function createControlMaterial(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false
  });
}

function createLineMaterial(color: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.8,
    depthTest: false,
    depthWrite: false
  });
}

function handleLength(handle: [number, number, number]): number {
  return Math.hypot(handle[0], handle[1], handle[2]);
}

function shouldShowCurveHandle(
  point: CurvePoint,
  handle: [number, number, number],
  handleKind: "in" | "out"
): boolean {
  if (point.mode === "mirrored") {
    return true;
  }
  if (point.mode === "auto") {
    return handleLength(handle) > 1e-9;
  }
  const mode = handleKind === "in" ? (point.handleInMode ?? "normal") : (point.handleOutMode ?? "normal");
  return mode !== "hard";
}

function getControlMeta(object: any): CurveControlMeta | null {
  if (!object || typeof object !== "object") {
    return null;
  }
  const meta = (object as { userData?: { curveControl?: CurveControlMeta } }).userData?.curveControl;
  if (!meta) {
    return null;
  }
  return meta;
}

export class CurveEditController {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly controlRoot = new THREE.Group();
  private readonly transformControls: any;
  private readonly transformHelper: any;
  private readonly controlObjects: any[] = [];
  private readonly pointVisualByIndex = new Map<number, CurvePointVisual>();
  private currentCamera: any;
  private activeActorId: string | null = null;
  private activeSignature = "";
  private activeControlMeta: CurveControlMeta | null = null;
  private dragHistoryPushed = false;
  private hoverObject: any | null = null;
  private hoveredPointActorId: string | null = null;
  private hoveredPointIndex: number | null = null;
  private pendingOrbitBlock = false;
  private readonly unregisterDeleteCommandHandler: () => void;

  public constructor(
    private readonly kernel: AppKernel,
    private readonly sceneController: SceneController,
    private readonly orbitControls: OrbitControls,
    private readonly domElement: HTMLElement,
    initialCamera: any
  ) {
    this.currentCamera = initialCamera;
    this.controlRoot.name = "curve-edit-controls";
    this.controlRoot.visible = false;
    this.transformControls = new TransformControls(initialCamera, domElement);
    this.transformControls.setMode("translate");
    this.transformControls.size = 1.2;
    this.transformHelper =
      typeof this.transformControls.getHelper === "function" ? this.transformControls.getHelper() : this.transformControls;

    this.transformControls.addEventListener("dragging-changed", (event: { value?: boolean }) => {
      const dragging = Boolean(event.value);
      (this.orbitControls as any).enabled = !dragging;
      if (dragging && !this.dragHistoryPushed && this.activeActorId) {
        this.kernel.store.getState().actions.pushHistory("Edit curve control");
        this.dragHistoryPushed = true;
      }
      if (!dragging) {
        this.dragHistoryPushed = false;
      }
    });

    this.transformControls.addEventListener("objectChange", () => {
      this.applyControlChange();
    });

    this.domElement.addEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.addEventListener("pointermove", this.onPointerMove, true);
    this.domElement.addEventListener("pointerup", this.onPointerUp, true);
    this.domElement.addEventListener("dblclick", this.onDoubleClick, true);
    window.addEventListener(CURVE_VERTEX_HOVER_EVENT, this.onCurveVertexHover as EventListener);
    window.addEventListener(CURVE_VERTEX_SELECT_EVENT, this.onCurveVertexSelect as EventListener);
    this.unregisterDeleteCommandHandler = keyboardCommandRouter.register("delete-selection", this.onDeleteCommand, 100);
  }

  public dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.removeEventListener("pointermove", this.onPointerMove, true);
    this.domElement.removeEventListener("pointerup", this.onPointerUp, true);
    this.domElement.removeEventListener("dblclick", this.onDoubleClick, true);
    window.removeEventListener(CURVE_VERTEX_HOVER_EVENT, this.onCurveVertexHover as EventListener);
    window.removeEventListener(CURVE_VERTEX_SELECT_EVENT, this.onCurveVertexSelect as EventListener);
    this.unregisterDeleteCommandHandler();
    this.transformControls.detach();
    this.transformControls.dispose();
    this.transformHelper?.parent?.remove(this.transformHelper);
    this.controlRoot.parent?.remove(this.controlRoot);
    this.controlRoot.clear();
    this.controlObjects.length = 0;
    this.pointVisualByIndex.clear();
    this.activeActorId = null;
    this.activeSignature = "";
    this.activeControlMeta = null;
    this.hoverObject = null;
    this.hoveredPointActorId = null;
    this.hoveredPointIndex = null;
    this.pendingOrbitBlock = false;
    (this.orbitControls as any).enabled = true;
    this.domElement.style.cursor = "";
  }

  public setCamera(camera: any): void {
    this.currentCamera = camera;
    this.transformControls.camera = camera;
  }

  public willHandlePointerDown(event: PointerEvent): boolean {
    return this.claimsPointerDown(event);
  }

  public update(): void {
    if (this.transformControls.dragging) {
      return;
    }
    const actor = this.getSingleSelectedCurveActor();
    if (!actor) {
      this.hideControls();
      return;
    }

    const signature = JSON.stringify({
      actorId: actor.id,
      transform: actor.transform,
      closed: actor.params.closed,
      handleSize: actor.params.handleSize,
      curveData: actor.params.curveData
    });

    if (actor.id === this.activeActorId && signature === this.activeSignature) {
      return;
    }

    this.activeActorId = actor.id;
    this.activeSignature = signature;
    this.rebuildControls(actor);
  }

  private getSingleSelectedCurveActor(): ActorNode | null {
    const state = this.kernel.store.getState().state;
    const actorSelection = state.selection.filter((entry) => entry.kind === "actor");
    if (actorSelection.length !== 1) {
      return null;
    }
    const selected = actorSelection[0];
    if (!selected) {
      return null;
    }
    const actor = state.actors[selected.id];
    if (!actor || actor.actorType !== "curve" || getCurveTypeFromActor(actor) !== "spline") {
      return null;
    }
    return actor;
  }

  private rebuildControls(actor: ActorNode): void {
    const actorObject = this.sceneController.getActorObject(actor.id);
    if (!(actorObject instanceof THREE.Object3D)) {
      this.hideControls();
      return;
    }
    this.ensureTransformHelperAttached();

    if (this.controlRoot.parent !== actorObject) {
      this.controlRoot.parent?.remove(this.controlRoot);
      actorObject.add(this.controlRoot);
    }

    this.controlRoot.clear();
    this.controlObjects.length = 0;
    this.pointVisualByIndex.clear();

    const curve = curveDataWithOverrides(actor);
    const sizeScaleRaw = Number(actor.params.handleSize ?? 0.5);
    const sizeScale = Number.isFinite(sizeScaleRaw) ? Math.max(0.1, Math.min(4, sizeScaleRaw)) : 0.5;
    const anchorRadius = 0.115 * sizeScale;
    const handleRadius = 0.09 * sizeScale;
    for (let pointIndex = 0; pointIndex < curve.points.length; pointIndex += 1) {
      const point = curve.points[pointIndex];
      if (!point || point.enabled === false) {
        continue;
      }
      const anchor = new THREE.Vector3(...point.position);
      const handles = getEffectiveCurveHandlesAt(curve, pointIndex);
      const inPos = new THREE.Vector3(
        point.position[0] + handles.handleIn[0],
        point.position[1] + handles.handleIn[1],
        point.position[2] + handles.handleIn[2]
      );
      const outPos = new THREE.Vector3(
        point.position[0] + handles.handleOut[0],
        point.position[1] + handles.handleOut[1],
        point.position[2] + handles.handleOut[2]
      );
      const showHandleIn = shouldShowCurveHandle(point, handles.handleIn, "in");
      const showHandleOut = shouldShowCurveHandle(point, handles.handleOut, "out");

      const lineIn = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([anchor.clone(), inPos.clone()]),
        createLineMaterial(0x2f7db8)
      );
      const lineOut = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([anchor.clone(), outPos.clone()]),
        createLineMaterial(0x2f7db8)
      );
      lineIn.renderOrder = 10;
      lineOut.renderOrder = 10;
      lineIn.visible = showHandleIn;
      lineOut.visible = showHandleOut;
      this.controlRoot.add(lineIn, lineOut);

      const anchorMesh = new THREE.Mesh(
        new THREE.SphereGeometry(anchorRadius, 16, 14),
        createControlMaterial(0xffd166)
      );
      anchorMesh.renderOrder = 11;
      anchorMesh.position.copy(anchor);
      anchorMesh.userData.curveControl = {
        actorId: actor.id,
        pointIndex,
        controlType: "anchor"
      } satisfies CurveControlMeta;

      const handleInMesh = new THREE.Mesh(
        new THREE.SphereGeometry(handleRadius, 14, 12),
        createControlMaterial(0x2fa3ff)
      );
      handleInMesh.renderOrder = 11;
      handleInMesh.position.copy(inPos);
      handleInMesh.userData.curveControl = {
        actorId: actor.id,
        pointIndex,
        controlType: "handleIn"
      } satisfies CurveControlMeta;

      const handleOutMesh = new THREE.Mesh(
        new THREE.SphereGeometry(handleRadius, 14, 12),
        createControlMaterial(0x2fa3ff)
      );
      handleOutMesh.renderOrder = 11;
      handleOutMesh.position.copy(outPos);
      handleOutMesh.userData.curveControl = {
        actorId: actor.id,
        pointIndex,
        controlType: "handleOut"
      } satisfies CurveControlMeta;

      this.controlRoot.add(anchorMesh);
      this.controlObjects.push(anchorMesh);
      if (showHandleIn) {
        this.controlRoot.add(handleInMesh);
        this.controlObjects.push(handleInMesh);
      }
      if (showHandleOut) {
        this.controlRoot.add(handleOutMesh);
        this.controlObjects.push(handleOutMesh);
      }
      this.pointVisualByIndex.set(pointIndex, {
        anchor: anchorMesh,
        handleIn: handleInMesh,
        handleOut: handleOutMesh,
        lineIn,
        lineOut
      });
    }

    this.controlRoot.visible = true;
    this.refreshControlSelectionVisuals();

    if (this.activeControlMeta) {
      const existing = this.controlObjects.find((object) => {
        const meta = getControlMeta(object);
        return (
          meta?.actorId === this.activeControlMeta?.actorId &&
          meta?.pointIndex === this.activeControlMeta?.pointIndex &&
          meta?.controlType === this.activeControlMeta?.controlType
        );
      });
      if (existing) {
        this.transformControls.attach(existing);
      } else {
        this.transformControls.detach();
        this.activeControlMeta = null;
      }
    }
  }

  private hideControls(): void {
    this.controlRoot.visible = false;
    this.controlRoot.clear();
    this.controlObjects.length = 0;
    this.pointVisualByIndex.clear();
    this.transformControls.detach();
    this.transformHelper.parent?.remove(this.transformHelper);
    this.activeActorId = null;
    this.activeSignature = "";
    this.activeControlMeta = null;
    this.hoverObject = null;
    this.hoveredPointActorId = null;
    this.hoveredPointIndex = null;
    this.emitCurveVertexSelection(null, null, "anchor");
    (this.orbitControls as any).enabled = true;
    this.domElement.style.cursor = "";
    this.dragHistoryPushed = false;
    this.pendingOrbitBlock = false;
  }

  private pickControl(event: PointerEvent): any | null {
    if (!this.currentCamera || this.controlObjects.length === 0) {
      return null;
    }
    const rect = this.domElement.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerNdc.set(x, y);
    this.raycaster.setFromCamera(this.pointerNdc, this.currentCamera);
    const hits = this.raycaster.intersectObjects(this.controlObjects, false);
    return hits[0]?.object ?? null;
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

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) {
      return;
    }
    const picked = this.pickControl(event);
    if (picked) {
      event.preventDefault();
      event.stopPropagation();
      this.pendingOrbitBlock = false;
      this.activeControlMeta = getControlMeta(picked);
      this.transformControls.attach(picked);
      this.refreshControlSelectionVisuals();
      if (this.activeControlMeta) {
        this.emitCurveVertexSelection(
          this.activeControlMeta.actorId,
          this.activeControlMeta.pointIndex,
          this.activeControlMeta.controlType
        );
      }
      this.kernel.store.getState().actions.setStatus(
        "Curve control selected. Drag gizmo handles for X/Y/Z or XY/XZ/YZ movement."
      );
      return;
    }
    if (this.isTransformGizmoHit(event)) {
      this.pendingOrbitBlock = true;
      (this.orbitControls as any).enabled = false;
      return;
    }
    if (!picked) {
      if (this.activeControlMeta) {
        this.transformControls.detach();
        this.activeControlMeta = null;
        this.refreshControlSelectionVisuals();
        this.emitCurveVertexSelection(null, null, "anchor");
      }
      return;
    }
  };

  private claimsPointerDown(event: PointerEvent): boolean {
    if (event.button !== 0) {
      return false;
    }
    if (this.transformControls.dragging) {
      return true;
    }
    if (this.pickControl(event)) {
      return true;
    }
    return this.isTransformGizmoHit(event);
  }

  private isTransformGizmoHit(event: PointerEvent): boolean {
    if (!this.activeControlMeta || !this.transformControls.object) {
      return false;
    }
    const pointer = this.pointerToNdc(event);
    if (!pointer) {
      return false;
    }
    this.transformControls.pointerHover(pointer);
    return Boolean(this.transformControls.axis);
  }

  private onPointerUp = (): void => {
    if (!this.pendingOrbitBlock) {
      return;
    }
    this.pendingOrbitBlock = false;
    if (!this.transformControls.dragging) {
      (this.orbitControls as any).enabled = true;
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    const picked = this.pickControl(event);
    if (picked !== this.hoverObject) {
      this.hoverObject = picked;
      this.domElement.style.cursor = picked ? "pointer" : "";
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const actor = this.getSingleSelectedCurveActor();
    if (!actor || this.kernel.store.getState().state.mode === "web-ro" || !this.currentCamera) {
      return;
    }
    const actorObject = this.sceneController.getActorObject(actor.id);
    if (!(actorObject instanceof THREE.Object3D)) {
      return;
    }

    const rect = this.domElement.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerNdc.set(x, y);
    this.raycaster.setFromCamera(this.pointerNdc, this.currentCamera);

    const cameraDirection = new THREE.Vector3();
    this.currentCamera.getWorldDirection(cameraDirection);
    const worldOrigin = new THREE.Vector3();
    actorObject.getWorldPosition(worldOrigin);
    const placePlane = new THREE.Plane().setFromNormalAndCoplanarPoint(cameraDirection, worldOrigin);
    const worldHit = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(placePlane, worldHit);
    if (!hit) {
      return;
    }

    const local = actorObject.worldToLocal(worldHit.clone());
    const nextCurve = appendCurvePoint(curveDataWithOverrides(actor), [local.x, local.y, local.z]);
    this.kernel.store.getState().actions.updateActorParams(actor.id, {
      curveData: nextCurve
    });
    this.kernel.store.getState().actions.setStatus("Curve vertex added.");
  };

  private applyControlChange(): void {
    if (!this.activeControlMeta || !this.transformControls.object) {
      return;
    }
    const state = this.kernel.store.getState().state;
    const actor = state.actors[this.activeControlMeta.actorId];
    if (!actor || actor.actorType !== "curve") {
      return;
    }

    const object = this.transformControls.object as { position: { x: number; y: number; z: number } };
    const curve = curveDataWithOverrides(actor);
    const point = curve.points[this.activeControlMeta.pointIndex];
    if (!point) {
      return;
    }

    let nextCurve = curve;
    const nextPosition: [number, number, number] = [object.position.x, object.position.y, object.position.z];

    if (this.activeControlMeta.controlType === "anchor") {
      nextCurve = setCurveAnchorPosition(curve, this.activeControlMeta.pointIndex, nextPosition);
    } else {
      const relative: [number, number, number] = [
        nextPosition[0] - point.position[0],
        nextPosition[1] - point.position[1],
        nextPosition[2] - point.position[2]
      ];
      nextCurve = setCurveHandlePosition(
        curve,
        this.activeControlMeta.pointIndex,
        this.activeControlMeta.controlType === "handleIn" ? "in" : "out",
        relative
      );
    }

    this.kernel.store.getState().actions.updateActorParamsNoHistory(actor.id, {
      curveData: nextCurve
    });
    this.updatePointVisuals(nextCurve);
  }

  private refreshControlSelectionVisuals(): void {
    for (const object of this.controlObjects) {
      const material = (object as { material?: { color?: { setHex(v: number): void } } }).material;
      const meta = getControlMeta(object);
      if (!material?.color || !meta) {
        continue;
      }
      const isActive =
        this.activeControlMeta?.actorId === meta.actorId &&
        this.activeControlMeta?.pointIndex === meta.pointIndex &&
        this.activeControlMeta?.controlType === meta.controlType;
      const isHoveredPoint =
        this.hoveredPointActorId === meta.actorId && this.hoveredPointIndex === meta.pointIndex;
      if (meta.controlType === "anchor") {
        material.color.setHex(isActive ? 0xfff0b5 : isHoveredPoint ? 0xffe08a : 0xffd166);
      } else {
        material.color.setHex(isActive ? 0x8cd3ff : isHoveredPoint ? 0x6bc3ff : 0x2fa3ff);
      }
    }
  }

  private updatePointVisuals(curve: ReturnType<typeof curveDataWithOverrides>): void {
    for (let pointIndex = 0; pointIndex < curve.points.length; pointIndex += 1) {
      const point = curve.points[pointIndex];
      const visuals = this.pointVisualByIndex.get(pointIndex);
      if (!point || !visuals) {
        continue;
      }
      if (point.enabled === false) {
        visuals.anchor.visible = false;
        visuals.handleIn.visible = false;
        visuals.handleOut.visible = false;
        visuals.lineIn.visible = false;
        visuals.lineOut.visible = false;
        continue;
      }
      const anchor = new THREE.Vector3(...point.position);
      const handles = getEffectiveCurveHandlesAt(curve, pointIndex);
      const inPos = new THREE.Vector3(
        point.position[0] + handles.handleIn[0],
        point.position[1] + handles.handleIn[1],
        point.position[2] + handles.handleIn[2]
      );
      const outPos = new THREE.Vector3(
        point.position[0] + handles.handleOut[0],
        point.position[1] + handles.handleOut[1],
        point.position[2] + handles.handleOut[2]
      );
      const showHandleIn = shouldShowCurveHandle(point, handles.handleIn, "in");
      const showHandleOut = shouldShowCurveHandle(point, handles.handleOut, "out");
      visuals.anchor.position.copy(anchor);
      visuals.handleIn.position.copy(inPos);
      visuals.handleOut.position.copy(outPos);
      visuals.handleIn.visible = showHandleIn;
      visuals.handleOut.visible = showHandleOut;
      visuals.lineIn.visible = showHandleIn;
      visuals.lineOut.visible = showHandleOut;
      visuals.lineIn.geometry = new THREE.BufferGeometry().setFromPoints([anchor.clone(), inPos.clone()]);
      visuals.lineOut.geometry = new THREE.BufferGeometry().setFromPoints([anchor.clone(), outPos.clone()]);
    }
  }

  private onDeleteCommand = (): boolean => {
    if (!this.activeControlMeta || !this.activeActorId) {
      return false;
    }
    const state = this.kernel.store.getState().state;
    if (state.mode === "web-ro") {
      return false;
    }
    const actor = state.actors[this.activeActorId];
    if (!actor || actor.actorType !== "curve") {
      return false;
    }
    const curve = curveDataWithOverrides(actor);
    if (curve.points.length <= 0) {
      this.kernel.store.getState().actions.setStatus("Cannot delete vertex: curve has no vertices.");
      return true;
    }
    const deletedPointIndex = this.activeControlMeta.pointIndex;
    const nextPoints = curve.points.filter((_, index) => index !== deletedPointIndex);
    this.kernel.store.getState().actions.updateActorParams(actor.id, {
      curveData: {
        ...curve,
        points: nextPoints
      }
    });
    this.transformControls.detach();
    this.activeSignature = "";
    if (nextPoints.length > 0) {
      const nextSelectedPointIndex = Math.max(0, Math.min(deletedPointIndex, nextPoints.length - 1));
      this.activeControlMeta = {
        actorId: actor.id,
        pointIndex: nextSelectedPointIndex,
        controlType: "anchor"
      };
      this.emitCurveVertexSelection(actor.id, nextSelectedPointIndex, "anchor");
    } else {
      this.activeControlMeta = null;
      this.emitCurveVertexSelection(null, null, "anchor");
    }
    this.kernel.store.getState().actions.setStatus("Curve vertex deleted.");
    return true;
  };

  private onCurveVertexHover = (event: Event): void => {
    const custom = event as CustomEvent<{ actorId?: string | null; pointIndex?: number | null }>;
    const actorId = custom.detail?.actorId ?? null;
    const pointIndex = custom.detail?.pointIndex;
    if (actorId === null || pointIndex === null || pointIndex === undefined) {
      this.hoveredPointActorId = null;
      this.hoveredPointIndex = null;
      this.refreshControlSelectionVisuals();
      return;
    }
    this.hoveredPointActorId = actorId;
    this.hoveredPointIndex = pointIndex;
    this.refreshControlSelectionVisuals();
  };

  private onCurveVertexSelect = (event: Event): void => {
    const custom = event as CustomEvent<{ actorId?: string | null; pointIndex?: number | null; controlType?: string }>;
    const actorId = custom.detail?.actorId ?? null;
    const pointIndex = custom.detail?.pointIndex;
    const controlTypeRaw = custom.detail?.controlType;
    const controlType: CurveControlType =
      controlTypeRaw === "handleIn" || controlTypeRaw === "handleOut" || controlTypeRaw === "anchor"
        ? controlTypeRaw
        : "anchor";
    if (!actorId || pointIndex === null || pointIndex === undefined || pointIndex < 0) {
      return;
    }
    if (actorId !== this.activeActorId) {
      return;
    }
    this.activeControlMeta = {
      actorId,
      pointIndex,
      controlType
    };
    const selectedControl = this.findControlObject(actorId, pointIndex, controlType);
    if (selectedControl) {
      this.transformControls.attach(selectedControl);
    } else {
      this.transformControls.detach();
      this.activeSignature = "";
    }
    this.refreshControlSelectionVisuals();
  };

  private findControlObject(actorId: string, pointIndex: number, controlType: CurveControlType): any | null {
    for (const object of this.controlObjects) {
      const meta = getControlMeta(object);
      if (!meta) {
        continue;
      }
      if (meta.actorId === actorId && meta.pointIndex === pointIndex && meta.controlType === controlType) {
        return object;
      }
    }
    return null;
  }

  private emitCurveVertexSelection(
    actorId: string | null,
    pointIndex: number | null,
    controlType: CurveControlType = "anchor"
  ): void {
    window.dispatchEvent(
      new CustomEvent(CURVE_VERTEX_SELECT_EVENT, {
        detail: {
          actorId,
          pointIndex,
          controlType
        }
      })
    );
  }

  private ensureTransformHelperAttached(): void {
    if (this.transformHelper.parent === this.sceneController.scene) {
      return;
    }
    this.transformHelper.parent?.remove(this.transformHelper);
    this.sceneController.scene.add(this.transformHelper);
  }
}
