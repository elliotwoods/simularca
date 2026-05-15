import WebSocket from "ws";

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node scripts/force-gc.mjs <ws-url>");
    process.exit(1);
  }
  const ws = new WebSocket(target);
  let id = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id != null) {
      const cb = pending.get(msg.id);
      if (cb) {
        pending.delete(msg.id);
        if (msg.error) cb.reject(new Error(JSON.stringify(msg.error)));
        else cb.resolve(msg.result);
      }
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const reqId = ++id;
      pending.set(reqId, { resolve, reject });
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });
  await new Promise((r) => ws.once("open", r));
  const readMem = async () => {
    const r = await send("Runtime.evaluate", {
      expression:
        "JSON.stringify({used: performance.memory && performance.memory.usedJSHeapSize, total: performance.memory && performance.memory.totalJSHeapSize})",
      returnByValue: true
    });
    return JSON.parse(r.result.value);
  };
  const before = await readMem();
  console.log("before", before);
  await send("HeapProfiler.collectGarbage");
  await new Promise((r) => setTimeout(r, 500));
  const after = await readMem();
  console.log("after ", after);
  console.log("delta_used_mb", ((before.used - after.used) / 1048576).toFixed(1));
  console.log("delta_total_mb", ((before.total - after.total) / 1048576).toFixed(1));
  ws.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
