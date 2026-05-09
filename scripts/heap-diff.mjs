import fs from "node:fs";

function loadSnapshot(file) {
  const text = fs.readFileSync(file, "utf8");
  const data = JSON.parse(text);
  const meta = data.snapshot.meta;
  const nodeFields = meta.node_fields;
  const nodeFieldCount = nodeFields.length;
  const typeIndex = nodeFields.indexOf("type");
  const nameIndex = nodeFields.indexOf("name");
  const selfSizeIndex = nodeFields.indexOf("self_size");
  const idIndex = nodeFields.indexOf("id");
  const nodeTypes = meta.node_types[typeIndex];
  const strings = data.strings;
  const nodes = data.nodes;
  const buckets = new Map();
  let totalNodes = 0;
  let totalSelfSize = 0;
  for (let i = 0; i < nodes.length; i += nodeFieldCount) {
    const type = nodeTypes[nodes[i + typeIndex]];
    const name = strings[nodes[i + nameIndex]];
    const selfSize = nodes[i + selfSizeIndex];
    const key = `${type}::${name}`;
    const bucket = buckets.get(key) ?? { count: 0, size: 0, type, name };
    bucket.count += 1;
    bucket.size += selfSize;
    buckets.set(key, bucket);
    totalNodes += 1;
    totalSelfSize += selfSize;
  }
  return { buckets, totalNodes, totalSelfSize };
}

function fmt(n) {
  return n.toLocaleString();
}

function fmtMb(n) {
  return (n / 1048576).toFixed(2) + " MB";
}

const [, , fileA, fileB] = process.argv;
if (!fileA || !fileB) {
  console.error("Usage: node scripts/heap-diff.mjs <a.heapsnapshot> <b.heapsnapshot>");
  process.exit(1);
}

console.error(`Loading ${fileA}…`);
const a = loadSnapshot(fileA);
console.error(`Loading ${fileB}…`);
const b = loadSnapshot(fileB);

console.log(`A total: ${fmt(a.totalNodes)} nodes, ${fmtMb(a.totalSelfSize)}`);
console.log(`B total: ${fmt(b.totalNodes)} nodes, ${fmtMb(b.totalSelfSize)}`);
console.log("");

const allKeys = new Set([...a.buckets.keys(), ...b.buckets.keys()]);
const diffs = [];
for (const key of allKeys) {
  const aBucket = a.buckets.get(key) ?? { count: 0, size: 0 };
  const bBucket = b.buckets.get(key) ?? { count: 0, size: 0, type: "", name: "" };
  const dCount = bBucket.count - aBucket.count;
  const dSize = bBucket.size - aBucket.size;
  if (dCount === 0 && dSize === 0) {
    continue;
  }
  const proto = b.buckets.get(key) ?? a.buckets.get(key);
  diffs.push({ key, type: proto.type, name: proto.name, dCount, dSize, bCount: bBucket.count, bSize: bBucket.size });
}

diffs.sort((x, y) => y.dSize - x.dSize);

console.log("Top growth by self_size delta (B - A):");
console.log("dCount    dSize        bCount    bSize        type::name");
for (const d of diffs.slice(0, 60)) {
  console.log(
    `${String(d.dCount).padStart(8)}  ${fmtMb(d.dSize).padStart(11)}  ${String(d.bCount).padStart(8)}  ${fmtMb(d.bSize).padStart(11)}  ${d.type}::${d.name.slice(0, 80)}`
  );
}
