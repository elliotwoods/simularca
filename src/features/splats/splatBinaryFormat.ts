const MAGIC = new Uint8Array([0x53, 0x50, 0x4c, 0x54]); // SPLT
const VERSION = 1;

export type SplatBinaryEncoding = "ply";

export interface ParsedSplatBinary {
  version: number;
  encoding: SplatBinaryEncoding;
  payload: Uint8Array;
}

function encodingToByte(encoding: SplatBinaryEncoding): number {
  if (encoding === "ply") {
    return 1;
  }
  return 0;
}

function byteToEncoding(byte: number): SplatBinaryEncoding {
  if (byte === 1) {
    return "ply";
  }
  throw new Error(`Unsupported splat binary encoding byte: ${String(byte)}`);
}

export function createSplatBinaryV1(payload: Uint8Array, encoding: SplatBinaryEncoding = "ply"): Uint8Array {
  const headerSize = 12;
  const out = new Uint8Array(headerSize + payload.byteLength);
  out.set(MAGIC, 0);
  const view = new DataView(out.buffer);
  view.setUint16(4, VERSION, true);
  view.setUint8(6, encodingToByte(encoding));
  view.setUint8(7, 0);
  view.setUint32(8, payload.byteLength, true);
  out.set(payload, headerSize);
  return out;
}

export function tryParseSplatBinary(bytes: Uint8Array): ParsedSplatBinary | null {
  if (bytes.byteLength < 12) {
    return null;
  }
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) {
      return null;
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const encoding = byteToEncoding(view.getUint8(6));
  const payloadSize = view.getUint32(8, true);
  const start = 12;
  const end = start + payloadSize;
  if (end > bytes.byteLength) {
    throw new Error("Invalid splat binary payload size.");
  }
  return {
    version,
    encoding,
    payload: bytes.slice(start, end)
  };
}

