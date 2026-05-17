/**
 * CaskDB benchmark — compares four configurations across three payload sizes.
 *
 *   fsync=off  queue=off  →  baseline: fastest, unsafe for concurrent writers
 *   fsync=off  queue=on   →  safe for concurrent writers, no durability guarantee
 *   fsync=on   queue=off  →  durable per-write, unsafe for concurrent writers
 *   fsync=on   queue=on   →  production default: durable + safe
 *
 * Best-practice patterns:
 *   1. Warm-up phase  — lets V8 JIT the async I/O state machines before timing.
 *   2. Pre-allocated Float64Array — zero GC allocation inside the hot loop.
 *   3. --expose-gc flush — separates GC pauses from the measurement window.
 *   4. Wall-clock throughput — captures queuing + sync overhead faithfully.
 *   5. Percentile statistics — p50/p95/p99 expose tail behaviour.
 *   6. Adaptive iteration count — fsync=on uses fewer iters (slow syscall);
 *      fsync=off uses more for stable percentile estimates.
 *
 * Run:
 *   npm run build && node --expose-gc dist/bench.js
 */

import { performance, PerformanceObserver } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStorage, type DiskStoreOptions } from "./disk-store.js";
import { HEADER_SIZE } from "./format.js";

// ─── Configuration ────────────────────────────────────────────────────────────

const WARMUP_ITERS = {
  withFsync: 25,    // fsync costs ~1–3 ms each; 25 is plenty for JIT warm-up
  noFsync:   200,   // much cheaper; 200 saturates V8's optimisation tiers
} as const;

const BENCH_ITERS = {
  withFsync: 500,   // 500 × ~2 ms ≈ 1 s per run — stable without being slow
  noFsync:   5_000, // 5 000 × ~5 µs ≈ 25 ms — needs more samples for p99
} as const;

const PAYLOAD_SIZES_BYTES = [64, 1_024, 16_384];

// Concurrent benchmark settings
const CONCURRENT_LEVELS = [4, 16, 64];      // parallel writers per batch
const CONCURRENT_BATCHES = 200;             // measured batches (≥100 needed for stable p99)
const CONCURRENT_WARMUP_BATCHES = 10;       // batches before measurement begins
const CONCURRENT_PAYLOAD_BYTES = 1_024;     // fixed 1 KB payload for concurrent runs

type BenchConfig = DiskStoreOptions & { label: string };

const WRITE_CONFIGS: BenchConfig[] = [
  { fsync: false, writeQueue: false,                   label: "fsync=off  queue=off  gc=off" },
  { fsync: false, writeQueue: true,                    label: "fsync=off  queue=on   gc=off" },
  { fsync: false, writeQueue: false, groupCommit: true, label: "fsync=off  queue=off  gc=on " },
  { fsync: true,  writeQueue: false,                   label: "fsync=on   queue=off  gc=off" },
  { fsync: true,  writeQueue: true,                    label: "fsync=on   queue=on   gc=off" },
  { fsync: true,  writeQueue: false, groupCommit: true, label: "fsync=on   queue=off  gc=on " },
];

// ─── GC tracking ─────────────────────────────────────────────────────────────

type GcStats = {
  count: number;      // total pauses observed
  totalMs: number;    // sum of all pause durations (ms)
  maxMs: number;      // longest single pause (ms)
  minorCount: number; // Scavenge — young-gen only, short
  majorCount: number; // MarkSweep / Incremental — old-gen, longer
};

/**
 * Runs `fn`, collecting every GC pause that fires during its execution via
 * PerformanceObserver. Pauses outside the call (warm-up, setup) are not counted.
 * The observer is disconnected synchronously after fn settles so no stray events
 * leak into the next benchmark run.
 */
async function withGcTracking<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; gc: GcStats }> {
  const gc: GcStats = { count: 0, totalMs: 0, maxMs: 0, minorCount: 0, majorCount: 0 };

  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.totalMs += entry.duration;
      if (entry.duration > gc.maxMs) gc.maxMs = entry.duration;
      // GC kind flags: 1=Scavenge(minor), 2=MarkSweep(major), 4=Incremental, 8=WeakCB
      const kind = (entry as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind ?? 0;
      if (kind === 1) gc.minorCount++; else gc.majorCount++;
    }
  });
  obs.observe({ entryTypes: ["gc"] });

  const result = await fn();
  obs.disconnect();
  return { result, gc };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function makePayload(size: number): string {
  return "x".repeat(size);
}

function pct(sorted: Float64Array, p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

function fmtSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(0)} MB`;
}

function fmtLatency(us: number): string {
  return us < 1_000 ? `${us.toFixed(1)} µs` : `${(us / 1_000).toFixed(2)} ms`;
}

function fmtThroughput(bytesPerSec: number): string {
  return `${(bytesPerSec / (1_024 * 1_024)).toFixed(2)} MB/s`;
}

// ─── Result type ──────────────────────────────────────────────────────────────

type BenchResult = {
  config: BenchConfig;
  iters: number;
  throughputBytesPerSec: number;
  mean: number; // µs
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  gc: GcStats;
};

// ─── Table printing ───────────────────────────────────────────────────────────

const COL = {
  label:      20,
  iters:       6,
  throughput: 12,
  latency:    10,
} as const;

function printTableHeader(): void {
  const h = (s: string, w: number) => s.padEnd(w);
  console.log(
    `  ${h("configuration", COL.label)}` +
    `  ${h("iters", COL.iters)}` +
    `  ${h("throughput", COL.throughput)}` +
    `  ${h("p50", COL.latency)}` +
    `  ${h("p95", COL.latency)}` +
    `  ${h("p99", COL.latency)}` +
    `  ${h("mean", COL.latency)}` +
    `  ${h("gc#", 4)}` +
    `  ${h("gc-ms", 7)}`
  );
  const sep = (w: number) => "─".repeat(w);
  console.log(
    `  ${sep(COL.label)}` +
    `  ${sep(COL.iters)}` +
    `  ${sep(COL.throughput)}` +
    `  ${sep(COL.latency)}` +
    `  ${sep(COL.latency)}` +
    `  ${sep(COL.latency)}` +
    `  ${sep(COL.latency)}` +
    `  ${sep(4)}` +
    `  ${sep(7)}`
  );
}

function printTableRow(r: BenchResult): void {
  const rj = (s: string, w: number) => s.padStart(w);
  const lj = (s: string, w: number) => s.padEnd(w);
  console.log(
    `  ${lj(r.config.label, COL.label)}` +
    `  ${rj(r.iters.toLocaleString(), COL.iters)}` +
    `  ${rj(fmtThroughput(r.throughputBytesPerSec), COL.throughput)}` +
    `  ${rj(fmtLatency(r.p50), COL.latency)}` +
    `  ${rj(fmtLatency(r.p95), COL.latency)}` +
    `  ${rj(fmtLatency(r.p99), COL.latency)}` +
    `  ${rj(fmtLatency(r.mean), COL.latency)}` +
    `  ${rj(String(r.gc.count), 4)}` +
    `  ${rj(r.gc.totalMs.toFixed(1), 7)}`
  );
}

// ─── Write benchmark ──────────────────────────────────────────────────────────

async function runWriteBench(
  payloadSize: number,
  config: BenchConfig,
): Promise<BenchResult> {
  const dir = await mkdtemp(join(tmpdir(), "caskdb-bench-"));
  const store = await DiskStorage(join(dir, "bench.db"), config);

  const val = makePayload(payloadSize);
  const warmup = config.fsync ? WARMUP_ITERS.withFsync : WARMUP_ITERS.noFsync;
  const iters  = config.fsync ? BENCH_ITERS.withFsync  : BENCH_ITERS.noFsync;
  const total  = warmup + iters;

  // Pre-build keys: one allocation outside the hot loop keeps the measured
  // work purely I/O + encode, with no string template overhead per iteration.
  const keys = Array.from({ length: total }, (_, i) => `key-${i}`);

  // ── Warm-up: give V8 time to JIT the full async write path ───────────────
  for (let i = 0; i < warmup; i++) {
    await store.set(keys[i]!, val);
  }

  // Flush GC before measurement to avoid a collection skewing tail latency.
  globalThis.gc?.();

  // ── Measurement ───────────────────────────────────────────────────────────
  const latencies = new Float64Array(iters); // pre-allocated: no GC per sample
  const keyLen = keys[warmup]!.length;
  const recordBytes = HEADER_SIZE + keyLen + payloadSize;

  let elapsedSec: number;
  const { result: _, gc } = await withGcTracking(async () => {
    const wallStart = performance.now();
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await store.set(keys[warmup + i]!, val);
      latencies[i] = (performance.now() - t0) * 1_000; // ms → µs
    }
    elapsedSec = (performance.now() - wallStart) / 1_000;
  });

  latencies.sort(); // Float64Array.sort() is numeric by default
  const mean = latencies.reduce((a, b) => a + b, 0) / iters;

  await store.close();
  await rm(dir, { recursive: true, force: true });

  return {
    config,
    iters,
    throughputBytesPerSec: (recordBytes * iters) / elapsedSec!,
    mean,
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
    p99: pct(latencies, 99),
    min: latencies[0] ?? 0,
    max: latencies[iters - 1] ?? 0,
    gc,
  };
}

// ─── Read benchmark ───────────────────────────────────────────────────────────
// Reads hit only the in-memory KeyDir + a single pread syscall. They are
// unaffected by fsync or writeQueue, so we run one config and vary payload.

async function runReadBench(payloadSize: number): Promise<BenchResult> {
  const dir = await mkdtemp(join(tmpdir(), "caskdb-bench-"));
  // Populate with queue+no-fsync for speed; read perf is config-independent.
  const store = await DiskStorage(join(dir, "bench.db"), {
    fsync: false,
    writeQueue: true,
  });

  const val = makePayload(payloadSize);
  const iters = BENCH_ITERS.noFsync;
  const warmup = WARMUP_ITERS.noFsync;
  const total = warmup + iters;
  const keys = Array.from({ length: total }, (_, i) => `key-${i}`);

  // Populate outside the measurement window.
  for (let i = 0; i < total; i++) {
    await store.set(keys[i]!, val);
  }

  for (let i = 0; i < warmup; i++) {
    await store.get(keys[i]!);
  }

  globalThis.gc?.();

  const latencies = new Float64Array(iters);
  const keyLen = keys[warmup]!.length;
  const recordBytes = HEADER_SIZE + keyLen + payloadSize;

  let elapsedSec: number;
  const { result: _, gc } = await withGcTracking(async () => {
    const wallStart = performance.now();
    for (let i = 0; i < iters; i++) {
      const t0 = performance.now();
      await store.get(keys[warmup + i]!);
      latencies[i] = (performance.now() - t0) * 1_000;
    }
    elapsedSec = (performance.now() - wallStart) / 1_000;
  });

  latencies.sort();
  const mean = latencies.reduce((a, b) => a + b, 0) / iters;

  await store.close();
  await rm(dir, { recursive: true, force: true });

  return {
    config: { fsync: false, writeQueue: true, label: "get()" },
    iters,
    throughputBytesPerSec: (recordBytes * iters) / elapsedSec!,
    mean,
    p50: pct(latencies, 50),
    p95: pct(latencies, 95),
    p99: pct(latencies, 99),
    min: latencies[0] ?? 0,
    max: latencies[iters - 1] ?? 0,
    gc,
  };
}

// ─── Concurrent write benchmark ───────────────────────────────────────────────

type ConcurrentBenchResult = {
  config: BenchConfig;
  concurrency: number;
  batches: number;
  throughputBytesPerSec: number;
  batchMean: number; // µs
  batchP50: number;
  batchP95: number;
  batchP99: number;
  /** Percentage of reads that returned the wrong value after concurrent writes. */
  corruptionPct: number;
  gc: GcStats;
};

/**
 * Fire `concurrency` concurrent set() calls per batch, repeat for
 * CONCURRENT_BATCHES batches, then read back every written key to measure
 * how many values were corrupted by the _writePosition race (queue=off only).
 */
async function runConcurrentWriteBench(
  payloadSize: number,
  concurrency: number,
  config: BenchConfig,
): Promise<ConcurrentBenchResult> {
  const dir = await mkdtemp(join(tmpdir(), "caskdb-bench-"));
  const store = await DiskStorage(join(dir, "bench.db"), config);
  const val = makePayload(payloadSize);

  // Fixed-width keys so every record is exactly the same byte length.
  // This makes position-mapping errors maximally visible: a read at a wrong
  // offset will always decode a different key's record or zeros.
  const totalKeys = (CONCURRENT_WARMUP_BATCHES + CONCURRENT_BATCHES) * concurrency;
  const keys = Array.from(
    { length: totalKeys },
    (_, i) => `k${String(i).padStart(7, "0")}`, // "k0000000" … fixed width
  );

  // ── Warm-up: let V8 JIT the Promise.all + async queue path ───────────────
  for (let b = 0; b < CONCURRENT_WARMUP_BATCHES; b++) {
    const base = b * concurrency;
    await Promise.all(
      Array.from({ length: concurrency }, (_, w) => store.set(keys[base + w]!, val)),
    );
  }

  globalThis.gc?.();

  // ── Measurement ───────────────────────────────────────────────────────────
  const keyOffset = CONCURRENT_WARMUP_BATCHES * concurrency;
  const recordBytes = HEADER_SIZE + keys[0]!.length + payloadSize;
  const batchLatencies = new Float64Array(CONCURRENT_BATCHES);

  let elapsedSec: number;
  const { result: _, gc } = await withGcTracking(async () => {
    const wallStart = performance.now();
    for (let b = 0; b < CONCURRENT_BATCHES; b++) {
      const base = keyOffset + b * concurrency;
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, (_, w) => store.set(keys[base + w]!, val)),
      );
      batchLatencies[b] = (performance.now() - t0) * 1_000; // ms → µs
    }
    elapsedSec = (performance.now() - wallStart) / 1_000;
  });

  const totalWrites = CONCURRENT_BATCHES * concurrency;

  // ── Correctness check ─────────────────────────────────────────────────────
  let correct = 0;
  for (let i = 0; i < totalWrites; i++) {
    try {
      const result = await store.get(keys[keyOffset + i]!);
      if (result === val) correct++;
    } catch {
      // Decode error from a misaligned position — counts as corrupted.
    }
  }
  const corruptionPct = ((totalWrites - correct) / totalWrites) * 100;

  batchLatencies.sort();
  const batchMean = batchLatencies.reduce((a, b) => a + b, 0) / CONCURRENT_BATCHES;

  await store.close();
  await rm(dir, { recursive: true, force: true });

  return {
    config,
    concurrency,
    batches: CONCURRENT_BATCHES,
    throughputBytesPerSec: (totalWrites * recordBytes) / elapsedSec!,
    batchMean,
    batchP50: pct(batchLatencies, 50),
    batchP95: pct(batchLatencies, 95),
    batchP99: pct(batchLatencies, 99),
    corruptionPct,
    gc,
  };
}

function printConcurrentHeader(): void {
  const h = (s: string, w: number) => s.padEnd(w);
  console.log(
    `  ${h("configuration", 17)}` +
    `  ${h("concur", 6)}` +
    `  ${h("throughput", 12)}` +
    `  ${h("batch-p50", 10)}` +
    `  ${h("batch-p95", 10)}` +
    `  ${h("batch-p99", 10)}` +
    `  ${h("corrupt%", 8)}` +
    `  ${h("gc#", 4)}` +
    `  ${h("gc-ms", 7)}`,
  );
  const d = (w: number) => "─".repeat(w);
  console.log(
    `  ${d(17)}  ${d(6)}  ${d(12)}  ${d(10)}  ${d(10)}  ${d(10)}  ${d(8)}  ${d(4)}  ${d(7)}`,
  );
}

function printConcurrentRow(r: ConcurrentBenchResult): void {
  const rj = (s: string, w: number) => s.padStart(w);
  const lj = (s: string, w: number) => s.padEnd(w);
  const corrupt =
    r.corruptionPct === 0
      ? "0%  ✓"
      : `${r.corruptionPct.toFixed(1)}%  ✗`;
  console.log(
    `  ${lj(r.config.label, 17)}` +
    `  ${rj(String(r.concurrency), 6)}` +
    `  ${rj(fmtThroughput(r.throughputBytesPerSec), 12)}` +
    `  ${rj(fmtLatency(r.batchP50), 10)}` +
    `  ${rj(fmtLatency(r.batchP95), 10)}` +
    `  ${rj(fmtLatency(r.batchP99), 10)}` +
    `  ${corrupt}` +
    `  ${rj(String(r.gc.count), 4)}` +
    `  ${rj(r.gc.totalMs.toFixed(1), 7)}`,
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────

const gcEnabled = typeof globalThis.gc === "function";

console.log("┌─ CaskDB Benchmark ─────────────────────────────────────────────────────┐");
console.log(`│  Node.js ${process.version.padEnd(8)}  platform: ${process.platform.padEnd(10)}                              │`);
console.log(`│  GC flush: ${(gcEnabled ? "yes (--expose-gc)" : "no  (rerun with --expose-gc)").padEnd(62)}│`);
console.log("└────────────────────────────────────────────────────────────────────────┘");

console.log("\n── set()  [sequential writes, one writer] ───────────────────────────────");
console.log("   fsync cost dominates write latency; queue adds negligible overhead");
console.log("   for sequential workloads but is required for concurrent correctness.\n");

for (const payloadSize of PAYLOAD_SIZES_BYTES) {
  console.log(`  payload ${fmtSize(payloadSize)}`);
  printTableHeader();
  for (const config of WRITE_CONFIGS) {
    const result = await runWriteBench(payloadSize, config);
    printTableRow(result);
  }
  console.log();
}

console.log("── get()  [KeyDir lookup + single pread, config-independent] ────────────\n");

printTableHeader();
for (const payloadSize of PAYLOAD_SIZES_BYTES) {
  const result = await runReadBench(payloadSize);
  // Reuse the table row but replace the label with the payload size.
  printTableRow({ ...result, config: { ...result.config, label: `payload ${fmtSize(payloadSize)}` } });
}

const CONCURRENT_CONFIGS: BenchConfig[] = [
  { fsync: false, writeQueue: false,                    label: "queue=off  gc=off" },
  { fsync: false, writeQueue: true,                     label: "queue=on   gc=off" },
  { fsync: false, writeQueue: false, groupCommit: true,  label: "queue=off  gc=on " },
];

console.log("\n── Concurrent write benchmark  [fsync=off, payload 1 KB] ───────────────");
console.log("   N writers fire simultaneously per batch.");
console.log("   gc=on coalesces all in-flight writes into one syscall per flush.");
console.log("   corrupt% = reads returning wrong data (KeyDir position race).\n");

printConcurrentHeader();
for (const concurrency of CONCURRENT_LEVELS) {
  for (const config of CONCURRENT_CONFIGS) {
    const result = await runConcurrentWriteBench(
      CONCURRENT_PAYLOAD_BYTES,
      concurrency,
      config,
    );
    printConcurrentRow(result);
  }
  console.log(); // blank line between concurrency groups
}

console.log("\nDone.");
