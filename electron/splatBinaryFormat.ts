const MAGIC = new Uint8Array([0x53, 0x50, 0x4c, 0x54]); // SPLT
const VERSION = 1;

function encodingToByte(encoding: "ply"): number {
  if (encoding === "ply") {
    return 1;
  }
  return 0;
}

export function createSplatBinaryV1(payload: Uint8Array, encoding: "ply" = "ply"): Uint8Array {
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

