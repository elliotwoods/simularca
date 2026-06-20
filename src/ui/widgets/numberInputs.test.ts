import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BufferedNumberTextInput } from "@/ui/widgets/BufferedNumberTextInput";
import { DigitScrubInput } from "@/ui/widgets/DigitScrubInput";
import { NumberField } from "@/ui/widgets/NumberField";
import { evaluateNumberExpression, inferDisplayPrecision, parseDraftNumber } from "@/ui/widgets/numberEditing";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

const originalResizeObserver = globalThis.ResizeObserver;
const originalGetContext = HTMLCanvasElement.prototype.getContext;
const mountedRoots: Root[] = [];
const mountedContainers: HTMLDivElement[] = [];

function renderElement(element: React.ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  act(() => {
    root.render(element);
  });
  return { container, root };
}

function dispatchInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  descriptor?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function blur(element: HTMLElement) {
  element.focus();
  act(() => {
    element.blur();
  });
}

function keydown(element: HTMLElement, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function dispatchPointerEvent(target: EventTarget, type: string, init: { clientX?: number; pointerId?: number } = {}) {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "clientX", { value: init.clientX ?? 0 });
  Object.defineProperty(event, "pointerId", { value: init.pointerId ?? 1 });
  act(() => {
    target.dispatchEvent(event);
  });
}

function dispatchMouseMove(movementX: number) {
  const event = new MouseEvent("mousemove", { bubbles: true });
  Object.defineProperty(event, "movementX", { value: movementX });
  act(() => {
    window.dispatchEvent(event);
  });
}

beforeAll(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    measureText: () => ({ width: 8 })
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  if (originalResizeObserver) {
    vi.stubGlobal("ResizeObserver", originalResizeObserver);
    return;
  }
  vi.unstubAllGlobals();
});

afterEach(() => {
  while (mountedRoots.length > 0) {
    const root = mountedRoots.pop();
    act(() => {
      root?.unmount();
    });
  }
  while (mountedContainers.length > 0) {
    mountedContainers.pop()?.remove();
  }
});

describe("DigitScrubInput", () => {
  it("enters edit mode when clicking on a digit", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 12.5,
        precision: 1,
        onChange
      })
    );

    const digit = Array.from(container.querySelectorAll(".digit")).find((node) => node.textContent === "1");
    expect(digit).not.toBeNull();
    click(digit as Element);

    expect(container.querySelector('input[type="text"]')).not.toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects an invalid enter, keeping the field open until escape reverts it", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 1.5,
        precision: 2,
        onChange
      })
    );

    click(container.querySelector("button") as HTMLButtonElement);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    dispatchInputValue(input, "-");

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".widget-buffered-number-indicator")?.textContent).toBe("!");

    input.focus();
    keydown(input, "Enter");

    // Invalid enter is rejected: nothing committed, field stays open.
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="text"]')).not.toBeNull();

    // Escape abandons the edit and reverts to the previous value.
    keydown(input, "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="text"]')).toBeNull();
    expect(container.textContent).toContain("1.50");
  });

  it("evaluates a formula on enter", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 1,
        precision: 2,
        onChange
      })
    );

    click(container.querySelector("button") as HTMLButtonElement);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    dispatchInputValue(input, "9.4/2");

    expect(container.querySelector(".widget-buffered-number-indicator")).toBeNull();

    input.focus();
    keydown(input, "Enter");

    expect(onChange).toHaveBeenCalledWith(4.7);
    expect(container.querySelector('input[type="text"]')).toBeNull();
  });

  it("snaps an evaluated formula to the step constraint", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 1,
        precision: 2,
        step: 0.1,
        onChange
      })
    );

    click(container.querySelector("button") as HTMLButtonElement);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    dispatchInputValue(input, "(1+2)*3/7");
    blur(input);

    // (1+2)*3/7 = 1.2857..., snapped to step 0.1 -> 1.3
    expect(onChange).toHaveBeenCalledWith(1.3);
  });

  it("rejects an incomplete formula on enter", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 1.5,
        precision: 2,
        onChange
      })
    );

    click(container.querySelector("button") as HTMLButtonElement);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    dispatchInputValue(input, "9.4/");

    expect(container.querySelector(".widget-buffered-number-indicator")?.textContent).toBe("!");

    input.focus();
    keydown(input, "Enter");

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="text"]')).not.toBeNull();
  });

  it("snaps stepped text commits on blur", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 1,
        precision: 2,
        step: 0.1,
        onChange
      })
    );

    click(container.querySelector("button") as HTMLButtonElement);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    dispatchInputValue(input, "1.23");
    blur(input);

    expect(onChange).toHaveBeenCalledWith(1.2);
  });

  it("keeps formatted trailing zeros after opening and committing unchanged text", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 0.05,
        precision: 3,
        onChange
      })
    );

    expect(container.textContent).toContain("0.050");

    click(container.querySelector("button") as HTMLButtonElement);
    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    keydown(input, "Enter");

    expect(onChange).toHaveBeenCalledWith(0.05);
    expect(container.textContent).toContain("0.050");
  });

  it("ignores the first locked mouse delta when a scrub drag starts", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(DigitScrubInput, {
        value: 5,
        precision: 0,
        onChange
      })
    );

    const digit = container.querySelector(".digit");
    const scrubButton = container.querySelector("button.widget-digit-input") as HTMLButtonElement | null;
    expect(digit).not.toBeNull();
    expect(scrubButton).not.toBeNull();

    const originalRequestPointerLock = HTMLButtonElement.prototype.requestPointerLock;
    const originalExitPointerLock = document.exitPointerLock;
    let pointerLockElement: Element | null = null;

    Object.defineProperty(document, "pointerLockElement", {
      configurable: true,
      get: () => pointerLockElement
    });

    HTMLButtonElement.prototype.requestPointerLock = function requestPointerLockStub() {
      pointerLockElement = scrubButton;
      document.dispatchEvent(new Event("pointerlockchange"));
      return Promise.resolve();
    };

    document.exitPointerLock = () => {
      pointerLockElement = null;
      document.dispatchEvent(new Event("pointerlockchange"));
    };

    try {
      dispatchPointerEvent(digit as Element, "pointerdown", { pointerId: 7, clientX: 100 });
      dispatchPointerEvent(window, "pointermove", { pointerId: 7, clientX: 104 });

      dispatchMouseMove(8);
      expect(onChange).not.toHaveBeenCalled();

      dispatchMouseMove(8);
      expect(onChange).toHaveBeenCalledWith(6);

      act(() => {
        window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    } finally {
      HTMLButtonElement.prototype.requestPointerLock = originalRequestPointerLock;
      document.exitPointerLock = originalExitPointerLock;
      Reflect.deleteProperty(document, "pointerLockElement");
    }
  });
});

describe("BufferedNumberTextInput", () => {
  it("rejects invalid drafts on blur, keeping the draft until escape reverts it", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(BufferedNumberTextInput, {
        value: 24,
        step: 1,
        precision: 0,
        onChange
      })
    );

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    act(() => {
      input.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    });
    dispatchInputValue(input, "1e-");

    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".widget-buffered-number-indicator")?.textContent).toBe("!");

    blur(input);

    // Invalid blur is rejected: nothing committed and the draft is preserved.
    expect(onChange).not.toHaveBeenCalled();
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("1e-");

    // Escape abandons the edit and restores the committed value.
    keydown(input, "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect((container.querySelector('input[type="text"]') as HTMLInputElement).value).toBe("24");
  });

  it("evaluates a formula on enter", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(BufferedNumberTextInput, {
        value: 24,
        precision: 1,
        onChange
      })
    );

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    act(() => {
      input.focus();
    });
    dispatchInputValue(input, "9.4/2");

    expect(container.querySelector(".widget-buffered-number-indicator")).toBeNull();

    keydown(input, "Enter");

    expect(onChange).toHaveBeenCalledWith(4.7);
  });
});

describe("NumberField", () => {
  it("uses digit scrub input for ranged values", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(NumberField, {
        label: "Test",
        value: 4,
        min: 0,
        max: 10,
        step: 0.5,
        precision: 1,
        onChange
      })
    );

    expect(container.querySelector('input[type="range"]')).not.toBeNull();
    expect(container.querySelector("button.widget-digit-input")).not.toBeNull();
  });

  it("does not show decimals for integer-stepped values", () => {
    const onChange = vi.fn();
    const { container } = renderElement(
      React.createElement(NumberField, {
        label: "Frames",
        value: 12,
        step: 1,
        onChange
      })
    );

    expect(container.textContent).toContain("12");
    expect(container.textContent).not.toContain("12.0");
    expect(container.textContent).not.toContain("12.00");
  });
});

describe("parseDraftNumber", () => {
  it("reads a plain number directly (number-first priority)", () => {
    expect(parseDraftNumber("2")).toBe(2);
    expect(parseDraftNumber("-3.5")).toBe(-3.5);
    expect(parseDraftNumber("1e3")).toBe(1000);
  });

  it("evaluates a formula when the text is not a plain number", () => {
    expect(parseDraftNumber("9.4/2")).toBe(4.7);
    expect(parseDraftNumber("(1+2)*3")).toBe(9);
    expect(parseDraftNumber("2 ** 10")).toBe(1024);
    expect(parseDraftNumber("sqrt(16)")).toBe(4);
    expect(parseDraftNumber("pi")).toBeCloseTo(Math.PI);
  });

  it("returns null for empty or invalid input", () => {
    expect(parseDraftNumber("")).toBeNull();
    expect(parseDraftNumber("   ")).toBeNull();
    expect(parseDraftNumber("9.4/")).toBeNull();
    expect(parseDraftNumber("abc")).toBeNull();
  });

  it("rejects expressions that do not resolve to a finite number", () => {
    expect(evaluateNumberExpression("1/0")).toBeNull();
    expect(evaluateNumberExpression("'5'")).toBeNull();
    expect(evaluateNumberExpression("[1,2]")).toBeNull();
    expect(evaluateNumberExpression("x".repeat(300))).toBeNull();
  });
});

describe("inferDisplayPrecision", () => {
  it("infers decimal places from step with a minimum of zero", () => {
    expect(inferDisplayPrecision(undefined, 1)).toBe(0);
    expect(inferDisplayPrecision(undefined, 0.1)).toBe(1);
    expect(inferDisplayPrecision(undefined, 0.01)).toBe(2);
    expect(inferDisplayPrecision(undefined, 0.125)).toBe(3);
  });
});

