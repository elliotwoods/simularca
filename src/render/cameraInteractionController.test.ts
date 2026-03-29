import * as THREE from "three";
import { describe, expect, it } from "vitest";
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
}

function createKernelStub(): AppKernel {
  return {
    store: {
      getState: () => ({
        state: {
          scene: {
            cameraKeyboardNavigation: false,
            cameraNavigationSpeed: 0
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

describe("CameraInteractionController middle pan", () => {
  it("applies consistent translation on consecutive middle-drag moves", () => {
    const domElement = createDomElement();
    const controls = {
      enabled: true,
      target: new THREE.Vector3(...BASE_CAMERA.target)
    };
    const camera = new THREE.PerspectiveCamera(BASE_CAMERA.fov, 1200 / 800, BASE_CAMERA.near, BASE_CAMERA.far);
    camera.position.set(...BASE_CAMERA.position);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
    camera.updateProjectionMatrix();

    const controller = new CameraInteractionController({
      kernel: createKernelStub(),
      domElement,
      controls,
      getCamera: () => camera
    }) as unknown as ControllerInternals;

    try {
      controller.onPointerDown(createPointerEvent(1, 4, 600, 400));

      const move1Before = camera.position.clone();
      controller.onPointerMove(createPointerEvent(1, 4, 612, 409));
      const move1Delta = camera.position.clone().sub(move1Before);

      const move2Before = camera.position.clone();
      controller.onPointerMove(createPointerEvent(1, 4, 624, 418));
      const move2Delta = camera.position.clone().sub(move2Before);

      expect(move1Delta.length()).toBeGreaterThan(0.1);
      expect(move2Delta.length()).toBeGreaterThan(0.1);
      expect(move2Delta.distanceTo(move1Delta)).toBeLessThan(1e-6);
      expect(controls.target.clone().sub(new THREE.Vector3(...BASE_CAMERA.target)).distanceTo(
        move1Delta.clone().add(move2Delta)
      )).toBeLessThan(1e-6);
    } finally {
      controller.onPointerUp(createPointerEvent(1, 0, 624, 418));
      (controller as unknown as { dispose(): void }).dispose();
      domElement.remove();
    }
  });
});
