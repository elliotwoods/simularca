import { describe, expect, it } from "vitest";
import { keyboardCommandRouter } from "@/app/keyboardCommandRouter";

describe("keyboard command router", () => {
  it("invokes higher-priority handler first", () => {
    const calls: string[] = [];
    const unregisterLow = keyboardCommandRouter.register("delete-selection", () => {
      calls.push("low");
      return false;
    }, 0);
    const unregisterHigh = keyboardCommandRouter.register("delete-selection", () => {
      calls.push("high");
      return true;
    }, 10);

    const handled = keyboardCommandRouter.dispatch("delete-selection", new KeyboardEvent("keydown", { key: "Delete" }));
    unregisterHigh();
    unregisterLow();

    expect(handled).toBe(true);
    expect(calls).toEqual(["high"]);
  });

  it("falls through when no handler handles command", () => {
    const unregister = keyboardCommandRouter.register("delete-selection", () => false, 0);
    const handled = keyboardCommandRouter.dispatch("delete-selection", new KeyboardEvent("keydown", { key: "Delete" }));
    unregister();
    expect(handled).toBe(false);
  });

  it("supports add actor browser shortcut handlers", () => {
    const calls: string[] = [];
    const unregister = keyboardCommandRouter.register("open-add-actor-browser", () => {
      calls.push("open");
      return true;
    });
    const handled = keyboardCommandRouter.dispatch("open-add-actor-browser", new KeyboardEvent("keydown", { key: "a" }));
    unregister();

    expect(handled).toBe(true);
    expect(calls).toEqual(["open"]);
  });
});
