import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { AppKernel } from "@/app/kernel";
import type { CameraState } from "@/core/types";
import { CameraInteractionController } from "@/render/cameraInteractionController";

const BASE_CAMERA: CameraState = {
  mode: "perspective",
  position: [100.38926763204485, 47.67287650696427, -6.078439381890998],
  target: [-1.3311298017990785, -2.4570796679546048, -1.1096826003750726],
  fov: 50,
  zoom: 1,
  near: 0.01,
  far: 1000
};

interface ControllerInternals {
  onPointerDown(event: PointerEvent): void;
  onPointerMove(event: PointerEvent): void;
  onPointerUp(event: PointerEvent): void;
  onWheel(event: WheelEvent): void;
  setPointerDownBlocker(blocker: ((event: PointerEvent) => boolean) | null): void;
}

function createKernelStub(
  sceneOverrides: Partial<{
    cameraKeyboardNavigation: boolean;
    cameraNavigationSpeed: number;
    cameraFlyLookInvertYaw: boolean;
    cameraFlyLookSpeed: number;
  }> = {}
): AppKernel {
  return {
    store: {
      getState: () => ({
        state: {
          scene: {
            cameraKeyboardNavigation: false,
            cameraNavigationSpeed: 0,
            cameraFlyLookInvertYaw: true,
            cameraFlyLookSpeed: 1,
            ...sceneOverrides
          },
          camera: BASE_CAMERA
        },
        actions: {
          cancelCameraTransition() {},
          requestCameraState() {}
        }
      })
    } as unknown as AppKernel["store"]
  } as AppKernel;
}

function createDomElement(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientHeight", { configurable: true, value: 800 });
  Object.defineProperty(element, "clientWidth", { configurable: true, value: 1200 });
  element.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 1200,
      bottom: 800,
      width: 1200,
      height: 800,
      x: 0,
      y: 0,
      toJSON() {
        return this;
      }
    }) as DOMRect;
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  document.body.appendChild(element);
  return element;
}

function createPointerEvent(button: number, buttons: number, clientX: number, clientY: number): PointerEvent {
  return {
    pointerId: 1,
    pointerType: "mouse",
    button,
    buttons,
    clientX,
    clientY,
    preventDefault() {},
    stopPropagation() {},
    target: document.body,
    currentTarget: document.body
  } as unknown as PointerEvent;
}

function createPerspectiveCameraAndControls() {
  const controls = {
    enabled: true,
    target: new THREE.Vector3(...BASE_CAMERA.target)
  };
  const camera = new THREE.PerspectiveCamera(BASE_CAMERA.fov, 1200 / 800, BASE_CAMERA.near, BASE_CAMERA.far);
  camera.position.set(...BASE_CAMERA.position);
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { camera, controls };
}

function createOrthographicCameraAndControls() {
  const aspect = 1200 / 800;
  const orthoSize = 8;
  const controls = {
    enabled: true,
    target: new THREE.Vector3(0, 0, 0),
    minZoom: 0.05,
    maxZoom: 200
  };
  const camera = new THREE.OrthographicCamera(
    -orthoSize * aspect,
    orthoSize * aspect,
    orthoSize,
    -orthoSize,
    0.01,
    1000
  );
  camera.position.set(0, 10, 0);
  camera.zoom = 1;
  camera.lookAt(controls.target);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { camera, controls };
}

function createWheelEvent(deltaY: number, clientX: number, clientY: number, domElement: HTMLElement): WheelEvent {
  return {
    deltaY,
    clientX,
    clientY,
    preventDefault() {},
    stopPropagation() {},
    target: domElement,
    currentTarget: domElement
  } as unknown as WheelEvent;
}

describe("CameraInteractionController remapped mouse controls", () => {
  it("applies consistent translation on consecutive right-drag moves", () => {
    const domElement = createDomElement();
    const { camera, controls } = createPerspectiveCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      controller.onPointerDown(createPointerEvent(2, 2, 600, 400));

      const move1Before = camera.position.clone();
      controller.onPointerMove(createPointerEvent(2, 2, 612, 409));
      const move1Delta = camera.position.clone().sub(move1Before);

      const move2Before = camera.position.clone();
      controller.onPointerMove(createPointerEvent(2, 2, 624, 418));
      const move2Delta = camera.position.clone().sub(move2Before);

      expect(move1Delta.length()).toBeGreaterThan(0.1);
      expect(move2Delta.length()).toBeGreaterThan(0.1);
      expect(move2Delta.distanceTo(move1Delta)).toBeLessThan(1e-6);
      expect(controls.target.clone().sub(new THREE.Vector3(...BASE_CAMERA.target)).distanceTo(
        move1Delta.clone().add(move2Delta)
      )).toBeLessThan(1e-6);
    } finally {
      controller.onPointerUp(createPointerEvent(2, 0, 624, 418));
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("zooms only after middle-drag exceeds the double-click tolerance", () => {
    const domElement = createDomElement();
    const { camera, controls } = createPerspectiveCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      const initialDistance = camera.position.distanceTo(controls.target);

      controller.onPointerDown(createPointerEvent(1, 4, 600, 400));
      controller.onPointerMove(createPointerEvent(1, 4, 603, 402));
      expect(camera.position.distanceTo(controls.target)).toBeCloseTo(initialDistance, 9);

      controller.onPointerMove(createPointerEvent(1, 4, 607, 408));
      expect(camera.position.distanceTo(controls.target)).toBeCloseTo(initialDistance, 9);

      controller.onPointerMove(createPointerEvent(1, 4, 607, 420));
      expect(camera.position.distanceTo(controls.target)).toBeGreaterThan(initialDistance);
    } finally {
      controller.onPointerUp(createPointerEvent(1, 0, 607, 420));
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("uses left-plus-right drag for fly-look rotation", () => {
    const domElement = createDomElement();
    const { camera, controls } = createPerspectiveCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      const initialPosition = camera.position.clone();
      const initialTarget = controls.target.clone();

      controller.onPointerDown(createPointerEvent(0, 3, 600, 400));
      controller.onPointerMove(createPointerEvent(0, 3, 640, 430));
      controller.onPointerUp(createPointerEvent(0, 0, 640, 430));

      const initialForward = initialTarget.clone().sub(initialPosition).setY(0).normalize();
      const finalForward = controls.target.clone().sub(camera.position).setY(0).normalize();

      expect(camera.position.distanceTo(initialPosition)).toBeLessThan(1e-9);
      expect(controls.target.distanceTo(initialTarget)).toBeGreaterThan(1e-6);
      expect(initialForward.clone().cross(finalForward).y).toBeLessThan(0);
    } finally {
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("respects the scene fly-look invert-yaw setting", () => {
    const domElement = createDomElement();
    const inverted = createPerspectiveCameraAndControls();
    const normal = createPerspectiveCameraAndControls();

    const invertedController = new CameraInteractionController({
      kernel: createKernelStub({ cameraFlyLookInvertYaw: true }),
      domElement,
      controls: inverted.controls,
      getCamera: () => inverted.camera
    }) as unknown as ControllerInternals;
    const normalController = new CameraInteractionController({
      kernel: createKernelStub({ cameraFlyLookInvertYaw: false }),
      domElement,
      controls: normal.controls,
      getCamera: () => normal.camera
    }) as unknown as ControllerInternals;

    try {
      invertedController.onPointerDown(createPointerEvent(0, 3, 600, 400));
      invertedController.onPointerMove(createPointerEvent(0, 3, 640, 400));
      invertedController.onPointerUp(createPointerEvent(0, 0, 640, 400));

      normalController.onPointerDown(createPointerEvent(0, 3, 600, 400));
      normalController.onPointerMove(createPointerEvent(0, 3, 640, 400));
      normalController.onPointerUp(createPointerEvent(0, 0, 640, 400));

      const baseForward = new THREE.Vector3(...BASE_CAMERA.target)
        .sub(new THREE.Vector3(...BASE_CAMERA.position))
        .setY(0)
        .normalize();
      const invertedForward = inverted.controls.target.clone().sub(inverted.camera.position).setY(0).normalize();
      const normalForward = normal.controls.target.clone().sub(normal.camera.position).setY(0).normalize();

      expect(baseForward.clone().cross(invertedForward).y).toBeLessThan(0);
      expect(baseForward.clone().cross(normalForward).y).toBeGreaterThan(0);
    } finally {
      (invertedController as unknown as { dispose(): void }).dispose();
      (normalController as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("scales fly-look rotation speed from scene settings", () => {
    const domElement = createDomElement();
    const slow = createPerspectiveCameraAndControls();
    const fast = createPerspectiveCameraAndControls();

    const slowController = new CameraInteractionController({
      kernel: createKernelStub({ cameraFlyLookSpeed: 0.5 }),
      domElement,
      controls: slow.controls,
      getCamera: () => slow.camera
    }) as unknown as ControllerInternals;
    const fastController = new CameraInteractionController({
      kernel: createKernelStub({ cameraFlyLookSpeed: 2 }),
      domElement,
      controls: fast.controls,
      getCamera: () => fast.camera
    }) as unknown as ControllerInternals;

    try {
      slowController.onPointerDown(createPointerEvent(0, 3, 600, 400));
      slowController.onPointerMove(createPointerEvent(0, 3, 640, 400));
      slowController.onPointerUp(createPointerEvent(0, 0, 640, 400));

      fastController.onPointerDown(createPointerEvent(0, 3, 600, 400));
      fastController.onPointerMove(createPointerEvent(0, 3, 640, 400));
      fastController.onPointerUp(createPointerEvent(0, 0, 640, 400));

      const baseForward = new THREE.Vector3(...BASE_CAMERA.target)
        .sub(new THREE.Vector3(...BASE_CAMERA.position))
        .setY(0)
        .normalize();
      const slowForward = slow.controls.target.clone().sub(slow.camera.position).setY(0).normalize();
      const fastForward = fast.controls.target.clone().sub(fast.camera.position).setY(0).normalize();
      const slowYaw = Math.acos(THREE.MathUtils.clamp(baseForward.dot(slowForward), -1, 1));
      const fastYaw = Math.acos(THREE.MathUtils.clamp(baseForward.dot(fastForward), -1, 1));

      expect(fastYaw).toBeGreaterThan(slowYaw * 2.5);
    } finally {
      (slowController as unknown as { dispose(): void }).dispose();
      (fastController as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("keeps double middle click bound to home view", () => {
    const domElement = createDomElement();
    const requestCameraState = vi.fn();
    const kernel = {
      store: {
        getState: () => ({
          state: {
            scene: {
              cameraKeyboardNavigation: false,
              cameraNavigationSpeed: 0,
              cameraFlyLookInvertYaw: true,
              cameraFlyLookSpeed: 1
            },
            camera: BASE_CAMERA
          },
          actions: {
            cancelCameraTransition() {},
            requestCameraState
          }
        })
      }
    } as unknown as AppKernel;
    const { camera, controls } = createPerspectiveCameraAndControls();

    const controller = new CameraInteractionController({
      kernel,
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      controller.onPointerDown(createPointerEvent(1, 4, 600, 400));
      controller.onPointerUp(createPointerEvent(1, 0, 600, 400));

      controller.onPointerDown(createPointerEvent(1, 4, 600, 400));

      expect(requestCameraState).toHaveBeenCalledTimes(1);
    } finally {
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("does not start orbit when a gizmo blocker claims the left-button pointerdown", () => {
    const domElement = createDomElement();
    const { camera, controls } = createPerspectiveCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      controller.setPointerDownBlocker(() => true);
      const initialPosition = camera.position.clone();
      const initialTarget = controls.target.clone();

      controller.onPointerDown(createPointerEvent(0, 1, 600, 400));
      controller.onPointerMove(createPointerEvent(0, 1, 640, 430));
      controller.onPointerUp(createPointerEvent(0, 0, 640, 430));

      expect(camera.position.distanceTo(initialPosition)).toBeLessThan(1e-9);
      expect(controls.target.distanceTo(initialTarget)).toBeLessThan(1e-9);
    } finally {
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("still starts orbit when no blocker claims the left-button pointerdown", () => {
    const domElement = createDomElement();
    const { camera, controls } = createPerspectiveCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      const initialPosition = camera.position.clone();
      const initialTarget = controls.target.clone();

      controller.onPointerDown(createPointerEvent(0, 1, 600, 400));
      controller.onPointerMove(createPointerEvent(0, 1, 640, 430));
      controller.onPointerUp(createPointerEvent(0, 0, 640, 430));

      expect(camera.position.distanceTo(initialPosition)).toBeGreaterThan(1e-6);
      expect(controls.target.distanceTo(initialTarget)).toBeLessThan(1e-9);
    } finally {
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("preserves world point under cursor after ortho wheel zoom-in", () => {
    const domElement = createDomElement();
    const { camera, controls } = createOrthographicCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      const cursorClientX = 900;
      const cursorClientY = 200;

      const rect = domElement.getBoundingClientRect();
      const cursorNdc = new THREE.Vector2(
        ((cursorClientX - rect.left) / rect.width) * 2 - 1,
        -((cursorClientY - rect.top) / rect.height) * 2 + 1
      );

      const worldBefore = new THREE.Vector3(cursorNdc.x, cursorNdc.y, 0).unproject(camera);

      controller.onWheel(createWheelEvent(-100, cursorClientX, cursorClientY, domElement));

      const worldAfter = new THREE.Vector3(cursorNdc.x, cursorNdc.y, 0).unproject(camera);

      expect(worldBefore.distanceTo(worldAfter)).toBeLessThan(1e-5);
      expect(camera.zoom).toBeGreaterThan(1);
    } finally {
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });

  it("does not translate camera when zooming at viewport center", () => {
    const domElement = createDomElement();
    const { camera, controls } = createOrthographicCameraAndControls();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      const initialPosition = camera.position.clone();
      const initialTarget = controls.target.clone();

      controller.onWheel(createWheelEvent(-100, 600, 400, domElement));

      expect(camera.position.distanceTo(initialPosition)).toBeLessThan(1e-9);
      expect(controls.target.distanceTo(initialTarget)).toBeLessThan(1e-9);
      expect(camera.zoom).toBeGreaterThan(1);
    } finally {
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });
});
