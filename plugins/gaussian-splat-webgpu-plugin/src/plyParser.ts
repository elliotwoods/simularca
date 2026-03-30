/**
 * Binary PLY parser for gaussian splat data.
 * Extracts positions, SH color coefficients, scales, rotations, and opacities
 * from binary little-endian PLY files (the standard format for 3DGS exports).
 */

export interface PlyGaussianData {
  count: number;
  positions: Float32Array;   // [x,y,z] interleaved, length = count * 3
  colors: Float32Array;      // [r,g,b] decoded from SH or packed color, length = count * 3
  scales: Float32Array;      // [sx,sy,sz] after exp() if log-encoded, length = count * 3
  rotations: Float32Array;   // [qx,qy,qz,qw] normalized, length = count * 4
  opacities: Float32Array;   // sigmoid applied, length = count
  colorSource: string;       // debug info: which color channel was used
}

type PlyType = "float" | "double" | "uchar" | "char" | "ushort" | "short" | "uint" | "int";

interface PlyProperty {
  name: string;
  type: PlyType;
  byteOffset: number;
  byteSize: number;
}

interface PlyHeader {
  vertexCount: number;
  properties: PlyProperty[];
  headerByteLength: number;
  vertexByteStride: number;
  format: "binary_little_endian" | "binary_big_endian" | "ascii";
}

const TYPE_SIZES: Record<string, number> = {
  float: 4, float32: 4,
  double: 8, float64: 8,
  uchar: 1, uint8: 1,
  char: 1, int8: 1,
  ushort: 2, uint16: 2,
  short: 2, int16: 2,
  uint: 4, uint32: 4,
  int: 4, int32: 4
};

function normalizePlyType(raw: string): PlyType {
  const map: Record<string, PlyType> = {
    float: "float", float32: "float",
    double: "double", float64: "double",
    uchar: "uchar", uint8: "uchar",
    char: "char", int8: "char",
    ushort: "ushort", uint16: "ushort",
    short: "short", int16: "short",
    uint: "uint", uint32: "uint",
    int: "int", int32: "int"
  };
  return map[raw.toLowerCase()] ?? "float";
}

function parseHeader(bytes: Uint8Array): PlyHeader {
  // Find end_header line
  const decoder = new TextDecoder("ascii");
  let headerEnd = -1;
  const endHeaderBytes = [
    0x65, 0x6e, 0x64, 0x5f, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72
  ]; // "end_header"

  for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
    if (bytes[i] === 0x65) { // 'e'
      let match = true;
      for (let j = 0; j < endHeaderBytes.length && i + j < bytes.length; j++) {
        if (bytes[i + j] !== endHeaderBytes[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        // Find the newline after end_header
        let lineEnd = i + endHeaderBytes.length;
        while (lineEnd < bytes.length && bytes[lineEnd] !== 0x0a) {
          lineEnd++;
        }
        headerEnd = lineEnd + 1;
        break;
      }
    }
  }

  if (headerEnd < 0) {
    throw new Error("Could not find end_header in PLY file");
  }

  const headerText = decoder.decode(bytes.slice(0, headerEnd));
  const lines = headerText.split(/\r?\n/);

  let vertexCount = 0;
  let format: PlyHeader["format"] = "binary_little_endian";
  const properties: PlyProperty[] = [];
  let inVertexElement = false;
  let byteOffset = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("format ")) {
      const parts = trimmed.split(/\s+/);
      if (parts[1] === "binary_little_endian") {
        format = "binary_little_endian";
      } else if (parts[1] === "binary_big_endian") {
        format = "binary_big_endian";
      } else if (parts[1] === "ascii") {
        format = "ascii";
      }
    } else if (trimmed.startsWith("element vertex ")) {
      vertexCount = parseInt(trimmed.split(/\s+/)[2], 10);
      inVertexElement = true;
      byteOffset = 0;
    } else if (trimmed.startsWith("element ")) {
      inVertexElement = false;
    } else if (trimmed.startsWith("property ") && inVertexElement) {
      const parts = trimmed.split(/\s+/);
      if (parts[1] === "list") {
        // Skip list properties (e.g. face indices)
        continue;
      }
      const typeName = parts[1];
      const propName = parts[2];
      const normalizedType = normalizePlyType(typeName);
      const byteSize = TYPE_SIZES[typeName.toLowerCase()] ?? 4;
      properties.push({
        name: propName,
        type: normalizedType,
        byteOffset,
        byteSize
      });
      byteOffset += byteSize;
    }
  }

  if (format === "ascii") {
    throw new Error("ASCII PLY format is not supported. Use binary_little_endian.");
  }

  return {
    vertexCount,
    properties,
    headerByteLength: headerEnd,
    vertexByteStride: byteOffset,
    format
  };
}

function readPropertyValue(
  view: DataView,
  offset: number,
  prop: PlyProperty,
  littleEndian: boolean
): number {
  switch (prop.type) {
    case "float":
      return view.getFloat32(offset, littleEndian);
    case "double":
      return view.getFloat64(offset, littleEndian);
    case "uchar":
      return view.getUint8(offset);
    case "char":
      return view.getInt8(offset);
    case "ushort":
      return view.getUint16(offset, littleEndian);
    case "short":
      return view.getInt16(offset, littleEndian);
    case "uint":
      return view.getUint32(offset, littleEndian);
    case "int":
      return view.getInt32(offset, littleEndian);
    default:
      return view.getFloat32(offset, littleEndian);
  }
}

function findProperty(properties: PlyProperty[], ...names: string[]): PlyProperty | null {
  for (const name of names) {
    const found = properties.find(p => p.name === name);
    if (found) return found;
  }
  return null;
}

const SH_C0 = 0.28209479177387814;

function sigmoid(x: number): number {
  return 1.0 / (1.0 + Math.exp(-x));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function parsePlyGaussianData(bytes: Uint8Array): PlyGaussianData {
  const header = parseHeader(bytes);
  const { vertexCount, properties, headerByteLength, vertexByteStride, format } = header;
  const littleEndian = format === "binary_little_endian";

  if (vertexCount <= 0) {
    return {
      count: 0,
      positions: new Float32Array(0),
      colors: new Float32Array(0),
      scales: new Float32Array(0),
      rotations: new Float32Array(0),
      opacities: new Float32Array(0),
      colorSource: "none"
    };
  }

  // Find properties
  const propX = findProperty(properties, "x");
  const propY = findProperty(properties, "y");
  const propZ = findProperty(properties, "z");
  if (!propX || !propY || !propZ) {
    throw new Error("PLY file missing position properties (x, y, z)");
  }

  const propFdc0 = findProperty(properties, "f_dc_0", "dc_0");
  const propFdc1 = findProperty(properties, "f_dc_1", "dc_1");
  const propFdc2 = findProperty(properties, "f_dc_2", "dc_2");
  const propRed = findProperty(properties, "red");
  const propGreen = findProperty(properties, "green");
  const propBlue = findProperty(properties, "blue");
  const propColor = findProperty(properties, "color", "rgba", "rgb", "diffuse", "albedo");

  const propScale0 = findProperty(properties, "scale_0", "sx");
  const propScale1 = findProperty(properties, "scale_1", "sy");
  const propScale2 = findProperty(properties, "scale_2", "sz");
  const propRot0 = findProperty(properties, "rot_0", "r_0");
  const propRot1 = findProperty(properties, "rot_1", "r_1");
  const propRot2 = findProperty(properties, "rot_2", "r_2");
  const propRot3 = findProperty(properties, "rot_3", "r_3");
  const propOpacity = findProperty(properties, "opacity", "alpha", "a");

  const hasShColor = Boolean(propFdc0 && propFdc1 && propFdc2);
  const hasPackedColor = Boolean(propColor);
  const hasSeparateColor = Boolean(propRed && propGreen && propBlue);
  const hasScale = Boolean(propScale0 && propScale1 && propScale2);
  const hasRotation = Boolean(propRot0 && propRot1 && propRot2 && propRot3);

  // Allocate output arrays
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const scales = new Float32Array(vertexCount * 3);
  const rotations = new Float32Array(vertexCount * 4);
  const opacities = new Float32Array(vertexCount);

  // Detect log-encoded scales: standard 3DGS PLY files store scale_0..2 as
  // log(actual_scale). Detect by sampling up to 10k vertices for negative values
  // (definitive: real scales can't be negative) or out-of-range values that
  // indicate log encoding (e.g., values > 10 would mean exp(10) = 22026).
  let useLogScale = false;
  if (hasScale) {
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sampleCount = Math.min(vertexCount, 10000);
    let hasNegative = false;
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < sampleCount; i++) {
      const vertexOffset = headerByteLength + i * vertexByteStride;
      const s0 = readPropertyValue(dataView, vertexOffset + propScale0!.byteOffset, propScale0!, littleEndian);
      const s1 = readPropertyValue(dataView, vertexOffset + propScale1!.byteOffset, propScale1!, littleEndian);
      const s2 = readPropertyValue(dataView, vertexOffset + propScale2!.byteOffset, propScale2!, littleEndian);
      if (s0 < 0 || s1 < 0 || s2 < 0) hasNegative = true;
      sMin = Math.min(sMin, s0, s1, s2);
      sMax = Math.max(sMax, s0, s1, s2);
    }
    // Negative values → definitely log-encoded (real scales are always positive)
    // Values outside [0, 10] → likely log-encoded (exp(10) = 22026, unrealistic scale)
    useLogScale = hasNegative || sMin < -0.5 || sMax > 10;
  }

  // Detect color denominator for packed colors
  let colorDenominator = 1;
  if (hasPackedColor && propColor) {
    if (propColor.type === "uchar") {
      colorDenominator = 255;
    } else {
      // Sample to detect range
      const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let maxVal = 0;
      const sampleCount = Math.min(vertexCount, 100);
      for (let i = 0; i < sampleCount; i++) {
        const vertexOffset = headerByteLength + i * vertexByteStride;
        const v = readPropertyValue(dataView, vertexOffset + propColor.byteOffset, propColor, littleEndian);
        maxVal = Math.max(maxVal, Math.abs(v));
      }
      if (maxVal > 2) colorDenominator = maxVal > 200 ? 255 : 1;
    }
  }

  // Determine color source priority (same as sceneController)
  const preferShColor = hasShColor && (!hasPackedColor || true); // SH color is most reliable for 3DGS
  let colorSource = "white";
  if (preferShColor) colorSource = "f_dc_0..2";
  else if (hasPackedColor) colorSource = "packed-color";
  else if (hasSeparateColor) colorSource = "red/green/blue";

  // Parse all vertices
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < vertexCount; i++) {
    const vertexOffset = headerByteLength + i * vertexByteStride;
    const i3 = i * 3;
    const i4 = i * 4;

    // Position
    positions[i3] = readPropertyValue(dataView, vertexOffset + propX.byteOffset, propX, littleEndian);
    positions[i3 + 1] = readPropertyValue(dataView, vertexOffset + propY.byteOffset, propY, littleEndian);
    positions[i3 + 2] = readPropertyValue(dataView, vertexOffset + propZ.byteOffset, propZ, littleEndian);

    // Color
    if (preferShColor && propFdc0 && propFdc1 && propFdc2) {
      const dc0 = readPropertyValue(dataView, vertexOffset + propFdc0.byteOffset, propFdc0, littleEndian);
      const dc1 = readPropertyValue(dataView, vertexOffset + propFdc1.byteOffset, propFdc1, littleEndian);
      const dc2 = readPropertyValue(dataView, vertexOffset + propFdc2.byteOffset, propFdc2, littleEndian);
      colors[i3] = clamp01(0.5 + SH_C0 * dc0);
      colors[i3 + 1] = clamp01(0.5 + SH_C0 * dc1);
      colors[i3 + 2] = clamp01(0.5 + SH_C0 * dc2);
    } else if (hasPackedColor && propColor) {
      const r = readPropertyValue(dataView, vertexOffset + propColor.byteOffset, propColor, littleEndian);
      const g = readPropertyValue(dataView, vertexOffset + propColor.byteOffset + propColor.byteSize, propColor, littleEndian);
      const b = readPropertyValue(dataView, vertexOffset + propColor.byteOffset + propColor.byteSize * 2, propColor, littleEndian);
      colors[i3] = clamp01(r / colorDenominator);
      colors[i3 + 1] = clamp01(g / colorDenominator);
      colors[i3 + 2] = clamp01(b / colorDenominator);
    } else if (hasSeparateColor && propRed && propGreen && propBlue) {
      colors[i3] = clamp01(readPropertyValue(dataView, vertexOffset + propRed.byteOffset, propRed, littleEndian) / 255);
      colors[i3 + 1] = clamp01(readPropertyValue(dataView, vertexOffset + propGreen.byteOffset, propGreen, littleEndian) / 255);
      colors[i3 + 2] = clamp01(readPropertyValue(dataView, vertexOffset + propBlue.byteOffset, propBlue, littleEndian) / 255);
    } else {
      colors[i3] = 1;
      colors[i3 + 1] = 1;
      colors[i3 + 2] = 1;
    }

    // Scale
    if (hasScale && propScale0 && propScale1 && propScale2) {
      const rawS0 = readPropertyValue(dataView, vertexOffset + propScale0.byteOffset, propScale0, littleEndian);
      const rawS1 = readPropertyValue(dataView, vertexOffset + propScale1.byteOffset, propScale1, littleEndian);
      const rawS2 = readPropertyValue(dataView, vertexOffset + propScale2.byteOffset, propScale2, littleEndian);
      scales[i3] = useLogScale ? Math.exp(rawS0) : Math.max(0.0001, rawS0);
      scales[i3 + 1] = useLogScale ? Math.exp(rawS1) : Math.max(0.0001, rawS1);
      scales[i3 + 2] = useLogScale ? Math.exp(rawS2) : Math.max(0.0001, rawS2);
    } else {
      scales[i3] = 0.01;
      scales[i3 + 1] = 0.01;
      scales[i3 + 2] = 0.01;
    }

    // Rotation (PLY layout: rot_0=w, rot_1=x, rot_2=y, rot_3=z → store as [x,y,z,w])
    if (hasRotation && propRot0 && propRot1 && propRot2 && propRot3) {
      const rw = readPropertyValue(dataView, vertexOffset + propRot0.byteOffset, propRot0, littleEndian);
      const rx = readPropertyValue(dataView, vertexOffset + propRot1.byteOffset, propRot1, littleEndian);
      const ry = readPropertyValue(dataView, vertexOffset + propRot2.byteOffset, propRot2, littleEndian);
      const rz = readPropertyValue(dataView, vertexOffset + propRot3.byteOffset, propRot3, littleEndian);
      // Normalize quaternion
      const len = Math.sqrt(rx * rx + ry * ry + rz * rz + rw * rw);
      if (len > 1e-10) {
        const invLen = 1 / len;
        rotations[i4] = rx * invLen;
        rotations[i4 + 1] = ry * invLen;
        rotations[i4 + 2] = rz * invLen;
        rotations[i4 + 3] = rw * invLen;
      } else {
        rotations[i4] = 0;
        rotations[i4 + 1] = 0;
        rotations[i4 + 2] = 0;
        rotations[i4 + 3] = 1;
      }
    } else {
      rotations[i4] = 0;
      rotations[i4 + 1] = 0;
      rotations[i4 + 2] = 0;
      rotations[i4 + 3] = 1;
    }

    // Opacity (logit-encoded in standard 3DGS exports → apply sigmoid)
    if (propOpacity) {
      const rawOpacity = readPropertyValue(dataView, vertexOffset + propOpacity.byteOffset, propOpacity, littleEndian);
      opacities[i] = sigmoid(rawOpacity);
    } else {
      opacities[i] = 1;
    }
  }

  return {
    count: vertexCount,
    positions,
    colors,
    scales,
    rotations,
    opacities,
    colorSource
  };
}
