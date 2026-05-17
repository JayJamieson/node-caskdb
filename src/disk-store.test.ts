import { afterAll, expect, suite, test } from "vitest";
import { DiskStorage, WriteQueue } from "./disk-store.js";

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Helper function to track and cleanup tmp files during test runs
 *
 * @returns cleanup function and tmp file creator
 */
const tmpFilePath = (): [() => Promise<void>, () => Promise<string>] => {
  const dirs: string[] = [];

  return [
    async () => {
      for (const dir of dirs) {
        await rm(dir, {
          force: true,
          recursive: true,
        });
      }
    },
    async (): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "foo-"));
      dirs.push(dir);
      const file = join(dir, "tmp.db");
      return file;
    },
  ];
};

suite("disk caskdb", () => {
  const [cleanUp, getTmpFile] = tmpFilePath();

  afterAll(async () => {
    await cleanUp();
  });

  test("get()", async () => {
    const path = await getTmpFile();

    const store = await DiskStorage(path);

    await store.set("foo", "bar");
    const result = await store.get("foo");

    expect(result).toBe("bar");

    await store.close();
  });

  test("invalid key", async () => {
    const path = await getTmpFile();
    const store = await DiskStorage(path);
    const result = await store.get("some key");

    expect(result).toBe(undefined);

    await store.close();
  });

  test("persistence", async () => {
    const path = await getTmpFile();
    let store = await DiskStorage(path);

    await store.set("crime and punishment", "dostoevsky");
    await store.set("anna karenina", "tolstoy");
    await store.set("war and peace", "tolstoy");
    await store.set("hamlet", "shakespeare");
    await store.set("othello", "shakespeare");
    await store.set("brave new world", "huxley");
    await store.set("dune", "frank herbert");

    await store.close();

    store = await DiskStorage(path);

    expect(await store.get("crime and punishment")).toBe("dostoevsky");
    expect(await store.get("anna karenina")).toBe("tolstoy");
    expect(await store.get("war and peace")).toBe("tolstoy");
    expect(await store.get("hamlet")).toBe("shakespeare");
    expect(await store.get("othello")).toBe("shakespeare");
    expect(await store.get("brave new world")).toBe("huxley");
    expect(await store.get("dune")).toBe("frank herbert");
    await store.close();
  });

  test("delete", async () => {
    const path = await getTmpFile();
    let store = await DiskStorage(path);

    await store.set("crime and punishment", "dostoevsky");
    await store.set("anna karenina", "tolstoy");
    await store.set("war and peace", "tolstoy");
    await store.set("hamlet", "shakespeare");
    await store.set("othello", "shakespeare");
    await store.set("brave new world", "huxley");
    await store.set("dune", "frank herbert");

    await store.set("crime and punishment", "");
    await store.set("anna karenina", "");
    await store.set("war and peace", "");
    await store.set("hamlet", "");
    await store.set("othello", "");
    await store.set("brave new world", "");
    await store.set("dune", "");

    await store.set("end", "yes");
    await store.close();

    store = await DiskStorage(path);

    expect(await store.get("crime and punishment")).toBe(undefined);
    expect(await store.get("anna karenina")).toBe(undefined);
    expect(await store.get("war and peace")).toBe(undefined);
    expect(await store.get("hamlet")).toBe(undefined);
    expect(await store.get("othello")).toBe(undefined);
    expect(await store.get("brave new world")).toBe(undefined);
    expect(await store.get("dune")).toBe(undefined);

    expect(await store.get("end")).toBe("yes");

    store.close();
  });

  test("existing file", async () => {
    const path = await getTmpFile();
    let store = await DiskStorage(path);
    await store.set("name", "jojo");

    expect(await store.get("name")).toBe("jojo");
    await store.close();

    store = await DiskStorage(path);
    expect(await store.get("name")).toBe("jojo");

    await store.close();
  });
});

// ─── Recommendation 1: Fix _writePosition initialisation ─────────────────────

suite("rec 1 — _writePosition not restored on restart", () => {
  // _initKeyDir rebuilds _keyDir correctly but never updates _writePosition.
  // It stays at 0, so the first set() after a restart records position=0 in
  // the KeyEntry. On Linux, O_APPEND + pwrite still appends to EOF, so the
  // bytes land at the right place on disk — but _keyDir points to byte 0.
  // get() then seeks to 0 and returns whichever record sits at the start of
  // the file, not the one just written.

  const [cleanUp, getTmpFile] = tmpFilePath();
  afterAll(async () => cleanUp());

  test("new key written after restart reads back its own value", async () => {
    const path = await getTmpFile();

    let store = await DiskStorage(path);
    await store.set("first-key", "first-value");
    await store.close();

    // Bug: _writePosition stays 0.
    store = await DiskStorage(path);
    await store.set("second-key", "second-value");

    // KeyEntry("second-key").position = 0 — get() seeks to 0 and decodes
    // "first-key"'s record, returning "first-value" instead of "second-value".
    expect(await store.get("second-key")).toBe("second-value");

    await store.close();
  });

  test("pre-existing key is not corrupted by a post-restart write", async () => {
    const path = await getTmpFile();

    let store = await DiskStorage(path);
    await store.set("original", "original-value");
    await store.close();

    store = await DiskStorage(path);
    await store.set("new-key", "new-value");

    expect(await store.get("original")).toBe("original-value");
    expect(await store.get("new-key")).toBe("new-value");

    await store.close();
  });

  test("file stays parseable across multiple restart cycles", async () => {
    // If _writePosition is wrong, successive restarts produce overlapping or
    // gapped records. The third reload's decodeHeader hits garbled bytes and
    // either throws or silently drops keys.
    const path = await getTmpFile();

    let store = await DiskStorage(path);
    await store.set("k1", "v1");
    await store.close();

    store = await DiskStorage(path);
    await store.set("k2", "v2");
    await store.close();

    store = await DiskStorage(path);
    await store.set("k3", "v3");
    await store.close();

    store = await DiskStorage(path);
    expect(await store.get("k1")).toBe("v1");
    expect(await store.get("k2")).toBe("v2");
    expect(await store.get("k3")).toBe("v3");
    await store.close();
  });
});

// ─── Recommendation 2: Fix poisoned WriteQueue ────────────────────────────────

suite("rec 2 — poisoned write queue", () => {
  // Bug in WriteQueue.enqueue:
  //   this.queue = this.queue.then(() => fn())
  // If fn() rejects, this.queue permanently holds a rejected promise. Every
  // subsequent .then() on it is skipped — the fn is never called and the
  // caller's promise rejects without touching disk.
  // Fix: the chain must survive individual failures, e.g.
  //   this.queue = this.queue.then(() => fn()).catch(() => {})

  test("a failed write does not prevent subsequent writes from executing", async () => {
    const wq = new WriteQueue();
    const executed: string[] = [];

    const writeA = wq.enqueue(async () => {
      executed.push("A");
      throw new Error("simulated I/O error");
    });

    // Enqueued while A is still pending.
    const writeB = wq.enqueue(async () => {
      executed.push("B");
    });

    await writeA.catch(() => {});
    await writeB.catch(() => {});

    expect(
      executed,
      "fn() for write-B must be called even after write-A fails",
    ).toContain("B");
  });

  test("every write enqueued after a failure is attempted", async () => {
    const wq = new WriteQueue();
    const executed: string[] = [];
    const promises: Promise<void>[] = [];

    promises.push(
      wq
        .enqueue(async () => {
          executed.push("fail");
          throw new Error("disk full");
        })
        .catch(() => {}),
    );

    for (let i = 1; i <= 4; i++) {
      const label = `write-${i}`;
      promises.push(
        wq
          .enqueue(async () => {
            executed.push(label);
          })
          .catch(() => {}),
      );
    }

    await Promise.all(promises);

    expect(executed).toContain("write-1");
    expect(executed).toContain("write-2");
    expect(executed).toContain("write-3");
    expect(executed).toContain("write-4");
  });
});

// ─── Recommendation 4: Chunked _initKeyDir reading ───────────────────────────

suite("rec 4 — _initKeyDir reads entire file into one Buffer", () => {
  // Bug: Buffer.alloc(stat.size) crashes with ERR_BUFFER_OUT_OF_BOUNDS when
  // the file reaches ~2 GB (Node.js Buffer limit).
  // Fix: scan the file record-by-record in fixed-size chunks (e.g. 64 KB) so
  // memory usage is O(chunk_size) regardless of file size.
  //
  // A unit test cannot create a 2 GB file, so these tests instead validate the
  // correctness invariants that any chunked implementation must preserve:
  // records spanning a chunk boundary, tombstones after the record they delete,
  // and last-write-wins ordering across the full file.

  const [cleanUp, getTmpFile] = tmpFilePath();
  afterAll(async () => cleanUp());

  test("all records are indexed correctly with many keys", async () => {
    const path = await getTmpFile();
    const store = await DiskStorage(path);
    const COUNT = 500;

    for (let i = 0; i < COUNT; i++) {
      await store.set(`key-${i}`, `value-${i}`);
    }
    await store.close();

    const reloaded = await DiskStorage(path);
    for (let i = 0; i < COUNT; i++) {
      expect(await reloaded.get(`key-${i}`), `key-${i}`).toBe(`value-${i}`);
    }
    await reloaded.close();
  });

  test("tombstones are applied correctly during reload across many records", async () => {
    const path = await getTmpFile();
    const store = await DiskStorage(path);

    for (let i = 0; i < 200; i++) {
      await store.set(`key-${i}`, `value-${i}`);
    }
    // Tombstone every even key.
    for (let i = 0; i < 200; i += 2) {
      await store.set(`key-${i}`, "");
    }
    await store.close();

    const reloaded = await DiskStorage(path);
    for (let i = 0; i < 200; i++) {
      if (i % 2 === 0) {
        expect(
          await reloaded.get(`key-${i}`),
          `key-${i} should be deleted`,
        ).toBeUndefined();
      } else {
        expect(await reloaded.get(`key-${i}`), `key-${i}`).toBe(`value-${i}`);
      }
    }
    await reloaded.close();
  });

  test("records with large values (>64 KB) are indexed correctly after reload", async () => {
    // 96 KB value guarantees the record body spans any reasonable chunk boundary.
    // A chunked scanner must re-assemble it correctly.
    const path = await getTmpFile();
    const store = await DiskStorage(path);

    const largeValue = "x".repeat(96 * 1024);
    await store.set("before", "small-value");
    await store.set("large", largeValue);
    await store.set("after", "another-value");
    await store.close();

    const reloaded = await DiskStorage(path);
    expect(await reloaded.get("before")).toBe("small-value");
    expect(await reloaded.get("large")).toBe(largeValue);
    expect(await reloaded.get("after")).toBe("another-value");
    await reloaded.close();
  });

  test("last-write-wins ordering is preserved across reload when a key is overwritten many times", async () => {
    // A chunked scanner must process records in strict file order so that
    // later overwrites always take precedence.
    const path = await getTmpFile();
    const store = await DiskStorage(path);

    for (let i = 0; i < 100; i++) {
      await store.set("contested", `version-${i}`);
    }
    await store.close();

    const reloaded = await DiskStorage(path);
    expect(await reloaded.get("contested")).toBe("version-99");
    await reloaded.close();
  });
});

suite("concurrent write safety", () => {
  const [cleanUp, getTmpFile] = tmpFilePath();

  afterAll(async () => {
    await cleanUp();
  });

  test("concurrent writes to different keys all read back correctly", async () => {
    // Bug: _writePosition is captured at the start of set() but only updated at
    // the end. With concurrent set() calls, multiple callers can snapshot the same
    // _writePosition value before any of them increments it. This means the
    // KeyEntry for each write records the WRONG byte offset, so get() reads from
    // the wrong location in the file and returns a different key's value.
    //
    // To maximise interleaving, values have deliberately varying lengths so that
    // any position swap produces a clearly wrong result.
    const path = await getTmpFile();
    const store = await DiskStorage(path);

    const pairs = Array.from(
      { length: 20 },
      (_, i) =>
        [
          `key-${i}`,
          `${"x".repeat(i + 1)}-value-${i}`, // different byte lengths per record
        ] as const,
    );

    await Promise.all(pairs.map(([k, v]) => store.set(k, v)));

    for (const [k, v] of pairs) {
      expect(await store.get(k), `key "${k}"`).toBe(v);
    }

    await store.close();
  });

  test("concurrent writes to the same key always return a written value", async () => {
    // Bug: without serialization, two concurrent writes to the same key race to
    // update _keyDir. The winner in _keyDir may not match the winner on disk —
    // e.g. write B's data lands at offset 20 but A's continuation (which ran last)
    // records _writePosition=20 for key A, so _keyDir points key at B's bytes.
    // The read then decodes the wrong record and returns a different key's value.
    const path = await getTmpFile();
    const store = await DiskStorage(path);

    const values = Array.from(
      { length: 20 },
      (_, i) => `value-${"x".repeat(i + 1)}`,
    );

    await Promise.all(values.map((v) => store.set("shared-key", v)));

    const result = await store.get("shared-key");

    // Must return last value that was actually written — not garbage,
    // not undefined, and not data belonging to a completely different record.
    expect(result).toBeDefined();
    expect(result).toEqual("value-xxxxxxxxxxxxxxxxxxxx");

    await store.close();
  });

  test("file on disk survives concurrent writes — reload rebuilds correct index", async () => {
    // The OS-level append is safe: each _file.write() call lands its bytes
    // contiguously, so the raw file data is always intact. The corruption is
    // purely in the in-memory _keyDir. Reloading the store forces _initKeyDir()
    // to scan the file sequentially and rebuild the index from scratch, which
    // should always produce the correct mapping.
    //
    // Contrast with the test above: if THIS test passes but the others fail,
    // the bug is confirmed to be an in-memory index race, not a file-write race.
    const path = await getTmpFile();
    let store = await DiskStorage(path);

    const pairs = Array.from(
      { length: 20 },
      (_, i) => [`key-${i}`, `value-${i}`] as const,
    );

    await Promise.all(pairs.map(([k, v]) => store.set(k, v)));
    await store.close();

    store = await DiskStorage(path);
    for (const [k, v] of pairs) {
      expect(await store.get(k), `after reload, key "${k}"`).toBe(v);
    }

    await store.close();
  });
});

// ─── close() drains in-flight writes ─────────────────────────────────────────

suite("close() drains in-flight writes before closing the file", () => {
  const [cleanUp, getTmpFile] = tmpFilePath();
  afterAll(async () => cleanUp());

  test("WriteQueue: close() waits for all enqueued writes to land on disk", async () => {
    // Fire off many concurrent writes, then immediately close without awaiting
    // each individual set(). close() must drain the queue so every write is
    // visible after reopening the store.
    const path = await getTmpFile();
    const store = await DiskStorage(path, { writeQueue: true });

    const pairs = Array.from({ length: 20 }, (_, i) => [`key-${i}`, `value-${i}`] as const);
    // Do NOT await individual set() calls — simulate fire-and-forget callers.
    const writes = pairs.map(([k, v]) => store.set(k, v));

    // close() must drain before returning.
    await store.close();

    // All promises should have settled by now (queue drained).
    await Promise.all(writes.map((p) => p.catch(() => {})));

    const reloaded = await DiskStorage(path);
    try {
      for (const [k, v] of pairs) {
        expect(await reloaded.get(k), `key "${k}" must be persisted`).toBe(v);
      }
    } finally {
      await reloaded.close();
    }
  });

  test("GroupCommitWriter: close() waits for the flush cycle to complete", async () => {
    const path = await getTmpFile();
    const store = await DiskStorage(path, { groupCommit: true });

    const pairs = Array.from({ length: 20 }, (_, i) => [`key-${i}`, `value-${i}`] as const);
    const writes = pairs.map(([k, v]) => store.set(k, v));

    await store.close();
    await Promise.all(writes.map((p) => p.catch(() => {})));

    const reloaded = await DiskStorage(path);
    try {
      for (const [k, v] of pairs) {
        expect(await reloaded.get(k), `key "${k}" must be persisted`).toBe(v);
      }
    } finally {
      await reloaded.close();
    }
  });
});
