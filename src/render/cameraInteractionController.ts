import * as THREE from "three";
import type { AppKernel } from "@/app/kernel";
import { cameraStateForHomeView, orbitCameraFromPointerDelta } from "@/features/camera/viewUtils";
import { DEFAULT_CAMERA_TRANSITION_DURATION_MS } from "@/features/camera/transitionController";

const CAMERA_NAV_KEYS = new Set(["w", "a", "s", "d", "q", "e"]);
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_CAMERA_DISTANCE = 9;
const EPSILON = 1e-6;
const DOUBLE_MIDDLE_CLICK_WINDOW_MS = 320;
const DOUBLE_MIDDLE_CLICK_TOLERANCE_PX = 6;

interface OrbitControlsTargetLike {
  enabled?: boolean;
  target: THREE.Vector3;
  minZoom?: number;
  maxZoom?: number;
  minDistance?: number;
  maxDistance?: number;
}

export interface CameraInteractionControllerOptions {
  kernel: AppKernel;
  domElement: HTMLElement;
  controls: OrbitControlsTargetLike;
  getCamera(): THREE.Camera | null;
  wheelZoomSpeed?: number;
}

type InteractionMode = "none" | "orbit" | "pan" | "fly";

interface PanState {
  plane: THREE.Plane;
  lastPoint: THREE.Vector3;
}

function getClientNdc(domElement: HTMLElement, clientX: number, clientY: number): THREE.Vector2 | null {
  const rect = domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1
  );
}

function updateCameraLookAt(camera: THREE.Camera, target: THREE.Vector3): void {
  camera.lookAt(target);
  camera.updateMatrixWorld();
  if (
    "updateProjectionMatrix" in camera &&
    typeof (camera as { updateProjectionMatrix?: () => void }).updateProjectionMatrix === "function"
  ) {
    (camera as { updateProjectionMatrix: () => void }).updateProjectionMatrix();
  }
}

function getCameraDistance(camera: THREE.Camera, target: THREE.Vector3): number {
  return Math.max(EPSILON, camera.position.distanceTo(target));
}

function getCameraForward(camera: THREE.Camera, target: THREE.Vector3): THREE.Vector3 {
  const forward = target.clone().sub(camera.position);
  if (forward.lengthSq() <= EPSILON) {
    return new THREE.Vector3(0, 0, -1);
  }
  return forward.normalize();
}

function rotateForward(forward: THREE.Vector3, yawDelta: number, pitchDelta: number): THREE.Vector3 {
  const next = forward.clone();
  const yaw = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, yawDelta);
  next.applyQuaternion(yaw);
  const right = new THREE.Vector3().crossVectors(next, WORLD_UP);
  if (right.lengthSq() > EPSILON) {
    right.normalize();
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, pitchDelta);
    const pitched = next.clone().applyQuaternion(pitch).normalize();
    if (Math.abs(pitched.dot(WORLD_UP)) < 0.9995) {
      next.copy(pitched);
    }
  }
  return next.normalize();
}

function buildPlaneFromCamera(point: THREE.Vector3, camera: THREE.Camera): THREE.Plane {
  const normal = new THREE.Vector3();
  camera.getWorldDirection(normal);
  return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point);
}

function intersectCameraPlane(camera: THREE.Camera, plane: THREE.Plane, ndc: THREE.Vector2): THREE.Vector3 | null {
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, hit) ? hit : null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

export class CameraInteractionController {
  private readonly kernel: AppKernel;
  private readonly domElement: HTMLElement;
  private readonly controls: OrbitControlsTargetLike;
  private readonly getCamera: () => THREE.Camera | null;
  private readonly wheelZoomSpeed: number;
  private readonly navigationKeysDown = new Set<string>();
  private readonly pointerClient = new THREE.Vector2();
  private readonly processedPointerClient = new THREE.Vector2();
  private readonly pointerDownClient = new THREE.Vector2();
  private readonly lastMiddleClickClient = new THREE.Vector2();
  private navigationLastAtMs = performance.now();
  private pointerId: number | null = null;
  private pointerButton: number | null = null;
  private mode: InteractionMode = "none";
  private panState: PanState | null = null;
  private middleClickCandidate = false;
  private lastMiddleClickAtMs = -Infinity;

  public constructor(options: CameraInteractionControllerOptions) {
    this.kernel = options.kernel;
    this.domElement = options.domElement;
    this.controls = options.controls;
    this.getCamera = options.getCamera;
    this.wheelZoomSpeed = options.wheelZoomSpeed ?? 0.12;

    this.domElement.addEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.addEventListener("pointermove", this.onPointerMove, true);
    this.domElement.addEventListener("pointerup", this.onPointerUp, true);
    this.domElement.addEventListener("pointercancel", this.onPointerUp, true);
    this.domElement.addEventListener("contextmenu", this.onContextMenu);
    this.domElement.addEventListener("wheel", this.onWheel, { passive: false, capture: true });
    window.addEventListener("keydown", this.onKeyDown, { capture: true });
    window.addEventListener("keyup", this.onKeyUp, { capture: true });
    window.addEventListener("blur", this.onWindowBlur);
  }

  public dispose(): void {
    this.domElement.removeEventListener("pointerdown", this.onPointerDown, true);
    this.domElement.removeEventListener("pointermove", this.onPointerMove, true);
    this.domElement.removeEventListener("pointerup", this.onPointerUp, true);
    this.domElement.removeEventListener("pointercancel", this.onPointerUp, true);
    this.domElement.removeEventListener("contextmenu", this.onContextMenu);
    this.domElement.removeEventListener("wheel", this.onWheel, true);
    window.removeEventListener("keydown", this.onKeyDown, true);
    window.removeEventListener("keyup", this.onKeyUp, true);
    window.removeEventListener("blur", this.onWindowBlur);
    this.navigationKeysDown.clear();
    this.clearInteractionState();
  }

  public update(nowMs: number): void {
    const deltaSeconds = Math.max(0, Math.min(0.1, (nowMs - this.navigationLastAtMs) / 1000));
    this.navigationLastAtMs = nowMs;
    if (deltaSeconds <= 0 || this.mode !== "fly") {
      return;
    }
    const scene = this.kernel.store.getState().state.scene;
    if (!scene.cameraKeyboardNavigation || this.navigationKeysDown.size === 0 || this.controls.enabled === false) {
      return;
    }
    const camera = this.getCamera();
    if (!camera) {
      return;
    }

    const speed = Math.max(0, Number(scene.cameraNavigationSpeed ?? 0));
    if (speed <= 0) {
      return;
    }

    const forwardAxisRaw = Number(this.navigationKeysDown.has("w")) - Number(this.navigationKeysDown.has("s"));
    const forwardAxis = camera instanceof THREE.OrthographicCamera ? 0 : forwardAxisRaw;
    const rightAxis = Number(this.navigationKeysDown.has("d")) - Number(this.navigationKeysDown.has("a"));
    const upAxis = Number(this.navigationKeysDown.has("e")) - Number(this.navigationKeysDown.has("q"));
    if (forwardAxis === 0 && rightAxis === 0 && upAxis === 0) {
      return;
    }

    const forward = getCameraForward(camera, this.controls.target);
    const right = new THREE.Vector3().crossVectors(forward, WORLD_UP);
    if (right.lengthSq() <= EPSILON) {
      right.set(1, 0, 0);
    } else {
      right.normalize();
    }

    const movement = new THREE.Vector3()
      .addScaledVector(forward, forwardAxis)
      .addScaledVector(right, rightAxis)
      .addScaledVector(WORLD_UP, upAxis);
    if (movement.lengthSq() <= EPSILON) {
      return;
    }
    movement.normalize().multiplyScalar(speed * deltaSeconds);
    camera.position.add(movement);
    this.controls.target.add(movement);
    updateCameraLookAt(camera, this.controls.target);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || this.controls.enabled === false) {
      return;
    }
    const camera = this.getCamera();
    if (!camera) {
      return;
    }

    const isPureMiddleClick = event.button === 1 && event.buttons === 4;
    if (isPureMiddleClick && this.shouldTriggerHomeView(event.clientX, event.clientY)) {
      event.preventDefault();
      this.kernel.store.getState().actions.cancelCameraTransition();
      this.kernel.store.getState().actions.requestCameraState(cameraStateForHomeView(), {
        animated: true,
        durationMs: DEFAULT_CAMERA_TRANSITION_DURATION_MS,
        markDirty: true
      });
      this.lastMiddleClickAtMs = -Infinity;
      return;
    }

    this.kernel.store.getState().actions.cancelCameraTransition();
    this.pointerId = event.pointerId;
    this.pointerButton = event.button;
    this.pointerClient.set(event.clientX, event.clientY);
    this.processedPointerClient.set(event.clientX, event.clientY);
    this.pointerDownClient.set(event.clientX, event.clientY);
    this.middleClickCandidate = isPureMiddleClick;
    this.domElement.setPointerCapture?.(event.pointerId);

    if (event.buttons === 3 || event.button === 1) {
      event.preventDefault();
      this.beginPan(camera, event.clientX, event.clientY);
      return;
    }
    if (event.button === 2) {
      event.preventDefault();
      this.beginFly(camera);
      return;
    }
    if (event.button === 0) {
      event.preventDefault();
      this.beginOrbit(camera, event.clientX, event.clientY);
    }
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || this.pointerId !== event.pointerId) {
      return;
    }
    const camera = this.getCamera();
    if (!camera) {
      return;
    }

    this.pointerClient.set(event.clientX, event.clientY);
    if (this.middleClickCandidate) {
      const toleranceSq = DOUBLE_MIDDLE_CLICK_TOLERANCE_PX * DOUBLE_MIDDLE_CLICK_TOLERANCE_PX;
      if (this.pointerClient.distanceToSquared(this.pointerDownClient) > toleranceSq) {
        this.middleClickCandidate = false;
      }
    }

    if (this.controls.enabled === false) {
      this.processedPointerClient.copy(this.pointerClient);
      return;
    }
    if (event.buttons === 0) {
      this.endInteraction(event.pointerId);
      return;
    }
    if (event.buttons === 3 && this.mode !== "pan") {
      this.beginPan(camera, event.clientX, event.clientY);
      this.processedPointerClient.copy(this.pointerClient);
      return;
    }

    if (this.mode === "orbit") {
      const dx = this.pointerClient.x - this.processedPointerClient.x;
      const dy = this.pointerClient.y - this.processedPointerClient.y;
      if (dx === 0 && dy === 0) {
        return;
      }
      const nextCamera = orbitCameraFromPointerDelta(
        {
          mode: camera instanceof THREE.OrthographicCamera ? "orthographic" : "perspective",
          position: [camera.position.x, camera.position.y, camera.position.z],
          target: [this.controls.target.x, this.controls.target.y, this.controls.target.z],
          fov: camera instanceof THREE.PerspectiveCamera ? camera.fov : this.kernel.store.getState().state.camera.fov,
          zoom: camera instanceof THREE.OrthographicCamera ? camera.zoom : this.kernel.store.getState().state.camera.zoom,
          near: camera.near,
          far: camera.far
        },
        dx,
        dy,
        this.domElement.clientHeight
      );
      camera.position.set(...nextCamera.position);
      this.controls.target.set(...nextCamera.target);
      updateCameraLookAt(camera, this.controls.target);
      this.processedPointerClient.copy(this.pointerClient);
      return;
    }

    if (this.mode === "pan" && this.panState) {
      const ndc = getClientNdc(this.domElement, event.clientX, event.clientY);
      if (!ndc) {
        return;
      }
      const currentPoint = intersectCameraPlane(camera, this.panState.plane, ndc);
      if (!currentPoint) {
        return;
      }
      const translation = this.panState.lastPoint.clone().sub(currentPoint);
      camera.position.add(translation);
      this.controls.target.add(translation);
      updateCameraLookAt(camera, this.controls.target);
      this.panState.lastPoint.copy(currentPoint);
      this.processedPointerClient.copy(this.pointerClient);
      return;
    }

    if (this.mode === "fly") {
      const dx = this.pointerClient.x - this.processedPointerClient.x;
      const dy = this.pointerClient.y - this.processedPointerClient.y;
      if (dx === 0 && dy === 0) {
        return;
      }
      const rotationScale = (Math.PI * 2) / Math.max(1, this.domElement.clientHeight);
      this.applyFlyDelta(camera, dx * rotationScale, dy * rotationScale);
      this.processedPointerClient.copy(this.pointerClient);
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.pointerId !== event.pointerId) {
      return;
    }
    this.endInteraction(event.pointerId);
  };

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private onWheel = (event: WheelEvent): void => {
    if (!this.isEventInsideViewport(event) || this.controls.enabled === false) {
      return;
    }
    this.kernel.store.getState().actions.cancelCameraTransition();
    event.preventDefault();
    this.applyWheelZoom(event);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (this.mode !== "fly" || this.controls.enabled === false) {
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(event.target)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (!CAMERA_NAV_KEYS.has(key)) {
      return;
    }
    this.navigationKeysDown.add(key);
    event.preventDefault();
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    const key = event.key.toLowerCase();
    if (!CAMERA_NAV_KEYS.has(key)) {
      return;
    }
    this.navigationKeysDown.delete(key);
  };

  private onWindowBlur = (): void => {
    this.navigationKeysDown.clear();
    this.clearInteractionState();
  };

  private shouldTriggerHomeView(clientX: number, clientY: number): boolean {
    const elapsed = performance.now() - this.lastMiddleClickAtMs;
    if (elapsed > DOUBLE_MIDDLE_CLICK_WINDOW_MS) {
      return false;
    }
    const dx = clientX - this.lastMiddleClickClient.x;
    const dy = clientY - this.lastMiddleClickClient.y;
    return dx * dx + dy * dy <= DOUBLE_MIDDLE_CLICK_TOLERANCE_PX * DOUBLE_MIDDLE_CLICK_TOLERANCE_PX;
  }

  private beginOrbit(camera: THREE.Camera, _clientX: number, _clientY: number): void {
    this.mode = "orbit";
    this.panState = null;
    updateCameraLookAt(camera, this.controls.target);
  }

  private beginPan(camera: THREE.Camera, clientX: number, clientY: number): void {
    const ndc = getClientNdc(this.domElement, clientX, clientY);
    if (!ndc) {
      return;
    }
    const plane = buildPlaneFromCamera(this.controls.target, camera);
    const hit = intersectCameraPlane(camera, plane, ndc);
    this.mode = "pan";
    this.panState = hit
      ? {
          plane,
          lastPoint: hit
        }
      : null;
  }

  private beginFly(camera: THREE.Camera): void {
    this.mode = "fly";
    this.panState = null;
    updateCameraLookAt(camera, this.controls.target);
  }

  private endInteraction(pointerId: number): void {
    if (this.pointerId !== pointerId) {
      return;
    }
    if (this.pointerButton === 1) {
      if (this.middleClickCandidate) {
        this.lastMiddleClickAtMs = performance.now();
        this.lastMiddleClickClient.copy(this.pointerDownClient);
      } else {
        this.lastMiddleClickAtMs = -Infinity;
      }
    }
    this.domElement.releasePointerCapture?.(pointerId);
    this.clearInteractionState();
  }

  private clearInteractionState(): void {
    this.pointerId = null;
    this.pointerButton = null;
    this.mode = "none";
    this.panState = null;
    this.navigationKeysDown.clear();
    this.middleClickCandidate = false;
  }

  private applyFlyDelta(camera: THREE.Camera, yawDelta: number, pitchDelta: number): void {
    const distance = getCameraDistance(camera, this.controls.target);
    const forward = rotateForward(getCameraForward(camera, this.controls.target), yawDelta, pitchDelta);
    this.controls.target
      .copy(camera.position)
      .add(forward.multiplyScalar(distance > EPSILON ? distance : DEFAULT_CAMERA_DISTANCE));
    updateCameraLookAt(camera, this.controls.target);
  }

  private applyWheelZoom(event: WheelEvent): void {
    const camera = this.getCamera();
    if (!camera) {
      return;
    }
    const delta = Number.isFinite(event.deltaY) ? event.deltaY : 0;
    if (delta === 0) {
      return;
    }
    const scalar = 1 + this.wheelZoomSpeed * Math.min(4, Math.abs(delta) / 100);

    if (camera instanceof THREE.OrthographicCamera) {
      const minZoom = Number(this.controls.minZoom ?? 0.05);
      const maxZoom = Number(this.controls.maxZoom ?? 200);
      const nextZoom = delta > 0 ? camera.zoom / scalar : camera.zoom * scalar;
      camera.zoom = Math.max(minZoom, Math.min(maxZoom, nextZoom));
      camera.updateProjectionMatrix();
      return;
    }

    const zoomFactor = delta > 0 ? scalar : 1 / scalar;
    const offset = camera.position.clone().sub(this.controls.target);
    if (offset.lengthSq() <= EPSILON) {
      offset.set(0, 0, DEFAULT_CAMERA_DISTANCE);
    }
    const distance = Math.max(EPSILON, offset.length());
    const minDistance = Number(this.controls.minDistance ?? 0.01);
    const maxDistance = Number(this.controls.maxDistance ?? 10000);
    const nextDistance = Math.max(minDistance, Math.min(maxDistance, distance * zoomFactor));
    camera.position.copy(this.controls.target).add(offset.normalize().multiplyScalar(nextDistance));
    updateCameraLookAt(camera, this.controls.target);
  }

  private isEventInsideViewport(event: Event): boolean {
    const path =
      typeof (event as Event & { composedPath?: () => EventTarget[] }).composedPath === "function"
        ? (event as Event & { composedPath: () => EventTarget[] }).composedPath()
        : [];
    if (path.length > 0) {
      return path.includes(this.domElement);
    }
    return event.target instanceof Node ? this.domElement.contains(event.target) : false;
  }
}
