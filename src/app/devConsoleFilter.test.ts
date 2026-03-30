import { describe, expect, it } from "vitest";
import { shouldSuppressDevConsoleMessage } from "@/app/devConsoleFilter";

describe("shouldSuppressDevConsoleMessage", () => {
  it("suppresses the React DevTools banner", () => {
    expect(
      shouldSuppressDevConsoleMessage([
        "Download the React DevTools for a better development experience: https://reactjs.org/link/react-devtools"
      ])
    ).toBe(true);
  });

  it("does not suppress ordinary warnings", () => {
    expect(shouldSuppressDevConsoleMessage(["Mesh load failed: missing.fbx"])).toBe(false);
    expect(shouldSuppressDevConsoleMessage([new Error("boom")])).toBe(false);
  });
});
