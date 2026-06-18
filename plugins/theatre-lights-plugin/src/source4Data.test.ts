import { describe, it, expect } from "vitest";
import {
  GELS,
  getGelSpec,
  getLampSpec,
  getLensSpec,
  getZoomBarrel,
  listGelOptions,
  listLensTubeOptions
} from "./source4Data";

describe("source4Data lamps", () => {
  it("resolves HPL 575W by id", () => {
    const lamp = getLampSpec("HPL575");
    expect(lamp).not.toBeNull();
    expect(lamp?.lumens).toBe(16520);
    expect(lamp?.cct).toBe(3250);
  });

  it("resolves a lamp by its readable label too", () => {
    expect(getLampSpec("HPL 575W")?.id).toBe("HPL575");
  });

  it("returns null for an unknown lamp", () => {
    expect(getLampSpec("nope")).toBeNull();
  });
});

describe("source4Data lenses", () => {
  it("resolves lens tubes by id and by label", () => {
    expect(getLensSpec("26deg")?.angleDeg).toBe(26);
    expect(getLensSpec("26°")?.angleDeg).toBe(26);
  });

  it("lists lens options in ascending angle order", () => {
    const options = listLensTubeOptions();
    expect(options[0]).toBe("5°");
    expect(options[options.length - 1]).toBe("90°");
  });

  it("resolves zoom barrels by id and label", () => {
    expect(getZoomBarrel("25-50")?.maxDeg).toBe(50);
    expect(getZoomBarrel("25–50° Zoom")?.minDeg).toBe(25);
  });
});

describe("source4Data gels", () => {
  it("resolves a gel by id and by composite label", () => {
    const byId = getGelSpec("L201");
    expect(byId?.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(byId?.approximate).toBe(true);
    expect(getGelSpec("L201 Full C.T.Blue")?.id).toBe("L201");
  });

  it("returns null for an unknown gel", () => {
    expect(getGelSpec("L9999")).toBeNull();
  });

  it("offers a readable preset list covering every gel", () => {
    expect(listGelOptions()).toHaveLength(GELS.length);
    for (const gel of GELS) {
      expect(gel.hex).toMatch(/^#[0-9a-fA-F]{6}$/);
      expect(gel.approximate).toBe(true);
    }
  });
});
