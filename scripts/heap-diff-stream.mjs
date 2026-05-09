// Streaming heap-snapshot diff. V8 heap snapshots are JSON but can exceed
// V8's 512MB max-string limit, so we parse the structure with Buffer-level
// scanning and only decode the sections we care about (nodes + strings).

import fs from "node:fs";

const FIELD_TYPE = "type";
const FIELD_NAME = "name";
const FIELD_SELF_SIZE = "self_size";

function readMetaAndStrings(filePath) {
  // Read the file head to find the snapshot meta (which tells us how many
  // fields per node) plus the trailing strings array. Keep these as utf-8
  // strings of bounded size.
  const HEAD_BYTES = 64 * 1024;
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const headBuf = Buffer.alloc(HEAD_BYTES);
    fs.readSync(fd, headBuf, 0, HEAD_BYTES, 0);
    const headText = headBuf.toString("utf8");

    // Extract the snapshot.meta JSON object.
    const metaStart = headText.indexOf('"meta":');
    if (metaStart === -1) {
      throw new Error('Could not find "meta" in snapshot head');
    }
    let depth = 0;
    let i = metaStart;
    while (i < headText.length && headText[i] !== "{") i++;
    const metaObjStart = i;
    for (; i < headText.length; i++) {
      const c = headText[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    const metaJson = headText.slice(metaObjStart, i);
    const meta = JSON.parse(metaJson);

    // Read the strings section. It starts with `"strings":[` and ends at the
    // closing `]` near the file end. Read the tail in chunks and assemble.
    // Use a moderate tail size that ideally captures it. We'll grow if needed.
    const TAIL_CHUNK = 32 * 1024 * 1024; // 32MB chunks
    let tail = Buffer.alloc(0);
    let offset = stat.size;
    const stringsMarker = Buffer.from('"strings":[');
    while (offset > 0) {
      const chunkSize = Math.min(TAIL_CHUNK, offset);
      const chunk = Buffer.alloc(chunkSize);
      offset -= chunkSize;
      fs.readSync(fd, chunk, 0, chunkSize, offset);
      tail = Buffer.concat([chunk, tail]);
      const idx = tail.indexOf(stringsMarker);
      if (idx !== -1) {
        // Found the strings section — parse from idx onward.
        const stringsStart = idx + stringsMarker.length - 1; // point at the [
        const stringsBuf = tail.subarray(stringsStart);
        // Decode in pieces to avoid the 512MB string limit. We need to find
        // each "..." and accumulate them into a JS array.
        const strings = parseStringArray(stringsBuf);
        return { meta, strings };
      }
      // Avoid unbounded growth; if we've read >256MB and still no marker, bail.
      if (tail.length > 256 * 1024 * 1024) {
        throw new Error("Could not find strings section in last 256MB of file");
      }
    }
    throw new Error('"strings":[ not found');
  } finally {
    fs.closeSync(fd);
  }
}

function parseStringArray(buf) {
  // buf starts at `[` and is followed by JSON-quoted strings separated by
  // commas, ending in `]`.
  const strings = [];
  let i = 0;
  // Skip opening `[`.
  while (i < buf.length && buf[i] !== 0x5b /* [ */) i++;
  i++;
  while (i < buf.length) {
    while (i < buf.length && (buf[i] === 0x20 || buf[i] === 0x2c || buf[i] === 0x0a || buf[i] === 0x0d)) i++;
    if (i >= buf.length || buf[i] === 0x5d /* ] */) break;
    if (buf[i] !== 0x22 /* " */) {
      throw new Error(`Unexpected char ${buf[i]} at strings index ${i}`);
    }
    // Locate matching closing quote, respecting escapes.
    const start = i;
    i++;
    while (i < buf.length) {
      const c = buf[i];
      if (c === 0x5c /* \ */) {
        i += 2;
        continue;
      }
      if (c === 0x22 /* " */) break;
      i++;
    }
    if (i >= buf.length) throw new Error("Unterminated string");
    const slice = buf.subarray(start, i + 1);
    // Decode just this slice — small enough to JSON.parse.
    const decoded = JSON.parse(slice.toString("utf8"));
    strings.push(decoded);
    i++;
  }
  return strings;
}

function* iterateNodes(filePath, nodeFieldCount) {
  // Stream the `"nodes":[INTS]` section, yielding chunks of node-field arrays.
  const fd = fs.openSync(filePath, "r");
  try {
    const stat = fs.fstatSync(fd);
    const HEAD_SCAN = 4 * 1024 * 1024; // first 4MB to find "nodes":[
    const headBuf = Buffer.alloc(Math.min(HEAD_SCAN, stat.size));
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const marker = Buffer.from('"nodes":[');
    const idx = headBuf.indexOf(marker);
    if (idx === -1) throw new Error('"nodes":[ not found in first 4MB');
    let absolute = idx + marker.length;
    let pending = ""; // partial number text across chunks
    let count = 0;
    const CHUNK = 8 * 1024 * 1024;
    let buf = Buffer.alloc(CHUNK);
    let nodeBuf = new Int32Array(nodeFieldCount);
    let fieldCursor = 0;
    while (absolute < stat.size) {
      const toRead = Math.min(CHUNK, stat.size - absolute);
      fs.readSync(fd, buf, 0, toRead, absolute);
      absolute += toRead;
      const text = pending + buf.subarray(0, toRead).toString("utf8");
      pending = "";
      let i = 0;
      while (i < text.length) {
        const c = text[i];
        if (c === " " || c === "\n" || c === "\t" || c === "\r" || c === ",") {
          i++;
          continue;
        }
        if (c === "]") {
          if (fieldCursor !== 0) {
            yield nodeBuf.slice();
            count++;
          }
          return;
        }
        // parse a number (digits only, possibly negative for some fields)
        let j = i;
        while (j < text.length && (text[j] === "-" || (text[j] >= "0" && text[j] <= "9"))) j++;
        if (j === text.length) {
          // partial — defer
          pending = text.slice(i);
          break;
        }
        const numText = text.slice(i, j);
        nodeBuf[fieldCursor++] = Number(numText);
        i = j;
        if (fieldCursor === nodeFieldCount) {
          yield nodeBuf;
          count++;
          fieldCursor = 0;
          nodeBuf = new Int32Array(nodeFieldCount);
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function aggregate(filePath) {
  const { meta, strings } = readMetaAndStrings(filePath);
  const nodeFields = meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const typeIdx = nodeFields.indexOf(FIELD_TYPE);
  const nameIdx = nodeFields.indexOf(FIELD_NAME);
  const selfSizeIdx = nodeFields.indexOf(FIELD_SELF_SIZE);
  const typeNames = meta.node_types[typeIdx];
  const buckets = new Map();
  let totalNodes = 0;
  let totalSelfSize = 0;
  for (const node of iterateNodes(filePath, nodeFieldCount)) {
    const type = typeNames[node[typeIdx]];
    const name = strings[node[nameIdx]];
    const selfSize = node[selfSizeIdx];
    const key = `${type}::${name}`;
    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, size: 0, type, name };
      buckets.set(key, b);
    }
    b.count++;
    b.size += selfSize;
    totalNodes++;
    totalSelfSize += selfSize;
  }
  return { buckets, totalNodes, totalSelfSize };
}

const fmt = (n) => n.toLocaleString();
const fmtMb = (n) => (n / 1048576).toFixed(2) + " MB";

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error("Usage: node scripts/heap-diff-stream.mjs <a.heapsnapshot> <b.heapsnapshot>");
  process.exit(1);
}

console.error(`Aggregating ${fileA}...`);
const a = aggregate(fileA);
console.error(`Aggregating ${fileB}...`);
const b = aggregate(fileB);

console.log(`A total: ${fmt(a.totalNodes)} nodes, ${fmtMb(a.totalSelfSize)}`);
console.log(`B total: ${fmt(b.totalNodes)} nodes, ${fmtMb(b.totalSelfSize)}`);
console.log("");

const allKeys = new Set([...a.buckets.keys(), ...b.buckets.keys()]);
const diffs = [];
for (const key of allKeys) {
  const aB = a.buckets.get(key) ?? { count: 0, size: 0 };
  const bB = b.buckets.get(key) ?? { count: 0, size: 0, type: "", name: "" };
  const dCount = bB.count - aB.count;
  const dSize = bB.size - aB.size;
  if (dCount === 0 && dSize === 0) continue;
  const proto = b.buckets.get(key) ?? a.buckets.get(key);
  diffs.push({ key, type: proto.type, name: proto.name, dCount, dSize, bCount: bB.count, bSize: bB.size });
}
diffs.sort((x, y) => y.dSize - x.dSize);

console.log("Top growth by self_size delta (B − A):");
console.log("dCount     dSize        bCount     bSize        type::name");
for (const d of diffs.slice(0, 60)) {
  console.log(
    `${String(d.dCount).padStart(8)}  ${fmtMb(d.dSize).padStart(11)}  ${String(d.bCount).padStart(8)}  ${fmtMb(d.bSize).padStart(11)}  ${d.type}::${(d.name ?? "").toString().slice(0, 80)}`
  );
}
