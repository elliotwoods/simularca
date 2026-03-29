import { describe, expect, it } from "vitest";
import { createDxfDrawingPlugin } from "../../../plugins/dxf-drawing-plugin/src/index";
import { buildDxfScene } from "../../../plugins/dxf-drawing-plugin/src/dxfScene";
import { parseDxf } from "../../../plugins/dxf-drawing-plugin/src/parseDxf";
import type { ParsedDxfDocument } from "../../../plugins/dxf-drawing-plugin/src/dxfTypes";

const blockFixture = [
  "0", "SECTION",
  "2", "HEADER",
  "0", "ENDSEC",
  "0", "SECTION",
  "2", "TABLES",
  "0", "TABLE",
  "2", "LAYER",
  "70", "3",
  "0", "LAYER",
  "2", "0",
  "62", "7",
  "70", "0",
  "0", "LAYER",
  "2", "BLOCK-LAYER",
  "62", "1",
  "70", "0",
  "0", "LAYER",
  "2", "TARGET-LAYER",
  "62", "3",
  "70", "0",
  "0", "ENDTAB",
  "0", "ENDSEC",
  "0", "SECTION",
  "2", "BLOCKS",
  "0", "BLOCK",
  "8", "0",
  "2", "TESTBLOCK",
  "70", "0",
  "10", "0",
  "20", "0",
  "30", "0",
  "3", "TESTBLOCK",
  "0", "LINE",
  "8", "0",
  "10", "0",
  "20", "0",
  "11", "10",
  "21", "0",
  "0", "CIRCLE",
  "8", "BLOCK-LAYER",
  "10", "5",
  "20", "5",
  "40", "2",
  "0", "ENDBLK",
  "0", "ENDSEC",
  "0", "SECTION",
  "2", "ENTITIES",
  "0", "INSERT",
  "8", "TARGET-LAYER",
  "2", "TESTBLOCK",
  "10", "100",
  "20", "200",
  "41", "2",
  "42", "2",
  "50", "90",
  "70", "2",
  "71", "1",
  "44", "20",
  "45", "0",
  "0", "ENDSEC",
  "0", "EOF"
].join("\n");

describe("DXF drawing plugin", () => {
  it("registers a DXF Drawing plugin actor", () => {
    const plugin = createDxfDrawingPlugin();
    const descriptor = plugin.actorDescriptors[0];
    expect(plugin.id).toBe("plugin.dxfDrawing");
    expect(descriptor?.spawn?.actorType).toBe("plugin");
    expect(descriptor?.spawn?.pluginType).toBe("plugin.dxfDrawing.actor");
    expect(descriptor?.spawn?.label).toBe("DXF Drawing");
  });

  it("parses block inserts and builds inherited layer geometry", () => {
    const parsed = parseDxf(blockFixture);
    expect(parsed.entities[0]).toMatchObject({ type: "INSERT", blockName: "TESTBLOCK" });
    expect(parsed.blocks.TESTBLOCK?.entities).toHaveLength(2);

    const built = buildDxfScene(parsed, {
      inputUnits: "millimeters",
      drawingPlane: "plan-xz",
      curveResolution: 24
    });

    expect(built.blockCount).toBe(1);
    expect(built.insertCount).toBe(1);
    expect(built.segmentCount).toBeGreaterThan(10);

    const inheritedLayer = built.layers.find((layer) => layer.layerName === "TARGET-LAYER");
    const blockLayer = built.layers.find((layer) => layer.layerName === "BLOCK-LAYER");
    expect(inheritedLayer?.linePositions.length).toBeGreaterThan(0);
    expect(blockLayer?.linePositions.length).toBeGreaterThan(0);
  });

  it("warns on cyclic block graphs instead of recursing forever", () => {
    const parsed: ParsedDxfDocument = {
      layers: [
        { name: "0", sourceColor: "#ffffff", order: 0 }
      ],
      layerMap: {
        "0": { name: "0", sourceColor: "#ffffff", order: 0 }
      },
      entities: [
        {
          type: "INSERT",
          layerName: "0",
          blockName: "A",
          position: [0, 0],
          xScale: 1,
          yScale: 1,
          rotationDeg: 0,
          columnCount: 1,
          rowCount: 1,
          columnSpacing: 0,
          rowSpacing: 0
        }
      ],
      blocks: {
        A: {
          name: "A",
          basePoint: [0, 0],
          layerName: "0",
          entities: [
            {
              type: "INSERT",
              layerName: "0",
              blockName: "B",
              position: [0, 0],
              xScale: 1,
              yScale: 1,
              rotationDeg: 0,
              columnCount: 1,
              rowCount: 1,
              columnSpacing: 0,
              rowSpacing: 0
            }
          ]
        },
        B: {
          name: "B",
          basePoint: [0, 0],
          layerName: "0",
          entities: [
            {
              type: "INSERT",
              layerName: "0",
              blockName: "A",
              position: [0, 0],
              xScale: 1,
              yScale: 1,
              rotationDeg: 0,
              columnCount: 1,
              rowCount: 1,
              columnSpacing: 0,
              rowSpacing: 0
            }
          ]
        }
      },
      unsupportedEntityCounts: {},
      warnings: []
    };

    const built = buildDxfScene(parsed, {
      inputUnits: "millimeters",
      drawingPlane: "plan-xz",
      curveResolution: 12
    });

    expect(built.warnings.some((warning) => /cyclic block reference/i.test(warning))).toBe(true);
  });
});
