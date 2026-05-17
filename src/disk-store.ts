/*
DiskStorage provides two simple operations to get and set key value pairs. Both key
and value need to be of string type, and all the data is persisted to disk.
During startup, DiskStorage loads all the existing KV pair metadata.

Note that if the database file is large, the initialisation will take time
accordingly. The initialisation is also a blocking operation; till it is completed,
we cannot use the database.

Typical usage example:

    const disk: DiskStorage = await DiskStore("books.db")
    await disk.set("othello", "shakespeare")
    const author: string = await disk.get("othello")

DiskStorage is a Log-Structured Hash Table as described in the BitCask paper. We
keep appending the data to a file, like a log. DiskStorage maintains an in-memory
hash table called KeyDir, which keeps the row's location on the disk.
The idea is simple yet brilliant:
  - Write the record to the disk
  - Update the internal hash table to point to that byte offset
  - Whenever we get a read request, check the internal hash table for the address,
      fetch that and return

KeyDir does not store values, only their locations.

The above approach solves a lot of problems:
  - Writes are insanely fast since you are just appending to the file
  - Reads are insanely fast since you do only one disk seek. In B-Tree backed
      storage, there could be 2-3 disk seeks

However, there are drawbacks too:
  - We need to maintain an in-memory hash table KeyDir. A database with a large
      number of keys would require more RAM
  - Since we need to build the KeyDir at initialisation, it will affect the startup
      time too
  - Deleted keys need to be purged from the file to reduce the file size

Read the paper for more details: https://riak.com/assets/bitcask-intro.pdf
*/

import { open, type FileHandle } from "node:fs/promises";
import {
  decodeHeader,
  decodeKV,
  encodeKV,
  HEADER_SIZE,
  KeyEntry,
  timestamp,
} from "./format.js";

export type DiskStore = {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | undefined>;
  close: () => Promise<void>;
};

export type DiskStoreOptions = {
  /**
   * Call fsync after every write to guarantee durability.
   * Dramatically increases write latency (~50–300 µs extra per write on SSDs).
   * Default: false
   */
  fsync?: boolean;
  /**
   * Serialise concurrent set() calls through an async queue so that
   * _writePosition and _keyDir are always consistent under concurrent load.
   * Disable only for single-writer workloads where you want to avoid the
   * promise-chaining overhead.
   * Default: true
   */
  writeQueue?: boolean;
  /**
   * Coalesce concurrent writes into a single syscall using group-commit.
   * All set() calls that arrive while a write is in flight are concatenated
   * into one Buffer and written with a single pwrite, dramatically reducing
   * syscall overhead under concurrent load. Implies writeQueue=false (the
   * GroupCommitWriter manages its own position accounting).
   * Default: false
   */
  groupCommit?: boolean;
};

export class WriteQueue {
  private queue: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void>): Promise<void> {
    // The chain stored in this.queue must never become a rejected promise —
    // if it does, every subsequent .then() is skipped and the queue is dead.
    // We separate the "chain stays alive" promise (which always resolves) from
    // the "caller sees the error" promise (which rejects on failure).
    const caller = this.queue.then(() => fn());
    this.queue = caller.catch(() => {});
    return caller;
  }
}

interface PendingWrite {
  buf: Buffer;
  resolve: (offset: number) => void;
  reject: (err: Error) => void;
}

class GroupCommitWriter {
  private pending: PendingWrite[] = [];
  private flushing = false;
  private drainCallbacks: (() => void)[] = [];

  constructor(
    private readonly file: FileHandle,
    private writePos: number,
  ) {}

  enqueue(buf: Buffer): Promise<number> {
    return new Promise((resolve, reject) => {
      this.pending.push({ buf, resolve, reject });
      if (!this.flushing) {
        this.flushing = true;
        setImmediate(() => this._flush());
      }
    });
  }

  /**
   * Resolves once all currently-pending and in-flight writes have been
   * flushed to disk. Safe to call even when the writer is idle.
   */
  drain(): Promise<void> {
    if (!this.flushing && this.pending.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.drainCallbacks.push(resolve);
    });
  }

  private async _flush(): Promise<void> {
    const batch = this.pending.splice(0);
    const combined = Buffer.concat(batch.map((p) => p.buf));
    const startOffset = this.writePos;

    try {
      await this.file.write(combined, 0, combined.length, startOffset);
      this.writePos += combined.length;

      let off = startOffset;
      for (const entry of batch) {
        entry.resolve(off);
        off += entry.buf.length;
      }
    } catch (err) {
      for (const entry of batch) entry.reject(err as Error);
    } finally {
      if (this.pending.length > 0) {
        setImmediate(() => this._flush());
      } else {
        this.flushing = false;
        const callbacks = this.drainCallbacks.splice(0);
        for (const cb of callbacks) cb();
      }
    }
  }

  get position(): number {
    return this.writePos;
  }
}

export async function DiskStorage(
  path: string,
  options: DiskStoreOptions = {},
): Promise<DiskStore> {
  const { fsync = false, writeQueue: useQueue = true, groupCommit = false } = options;
  /**
   * is a map of key and KeyEntry being the value.
   * KeyEntry contains the position of the byte offset in the file where the
   * value exists. key_dir map acts as in-memory index to fetch the values
   * quickly from the disk
   */
  const _keyDir = new Map<string, KeyEntry>();

  /**
   * current cursor position in the file where the data can be written
   */
  let _writePosition = 0;

  /**
   * file object pointing the path
   */
  let _file = await open(path, "a+");

  // groupCommit takes priority: it manages its own position accounting and
  // batches concurrent writes into a single syscall, so the WriteQueue is not
  // needed alongside it.
  const gcWriter = groupCommit ? new GroupCommitWriter(_file, _writePosition) : null;
  const queue = !groupCommit && useQueue ? new WriteQueue() : null;
  await _initKeyDir();

  async function _initKeyDir(): Promise<void> {
    // we will initialise the _keyDir by reading the contents of the file, record by
    // record. As we read each record, we will also update our KeyDir with the
    // corresponding KeyEntry
    //
    // NOTE: this method is a blocking one, if the DB size is huge then it will take
    // a lot of time to startup
    const stat = await _file.stat();
    const buffer = Buffer.alloc(stat.size);

    const readResult = await _file.read(buffer, 0, stat.size, 0);

    // empty caskDB, no need to run init
    if (readResult.bytesRead === 0) {
      return;
    }

    let offset = 0;
    while (offset < readResult.bytesRead) {
      const [timestamp, keySize, valueSize] = decodeHeader(buffer, offset);
      const entrySize = HEADER_SIZE + keySize + valueSize;

      const key = buffer.toString(
        "utf8",
        offset + HEADER_SIZE,
        offset + HEADER_SIZE + keySize,
      );

      const value = buffer.toString(
        "utf8",
        offset + HEADER_SIZE + keySize,
        offset + HEADER_SIZE + keySize + valueSize,
      );

      // tombstone value encountered, remove if exists otherwise continue
      if (value === "" && _keyDir.has(key)) {
        _keyDir.delete(key);
        offset += entrySize;
        continue;
      }

      _keyDir.set(key, {
        size: HEADER_SIZE + keySize + valueSize,
        position: offset,
        timestamp: timestamp,
      });

      offset += entrySize;
    }

    // Set write position to the end of all scanned data — including tombstone
    // records — so new writes never overlap existing records.
    _writePosition = readResult.bytesRead;
  }

  /**
   * set stores the key and value on the disk
   * @param key
   * @param value
   */
  async function set(key: string, value: string): Promise<void> {
    const inner = async () => {
      const ts = timestamp();
      const data = encodeKV(ts, key, value);

      let position: number;
      if (gcWriter !== null) {
        // Group-commit path: enqueue into the coalescing writer. Writes that
        // arrive while a flush is in-flight are concatenated into one Buffer
        // and land in a single pwrite syscall.
        position = await gcWriter.enqueue(data);
      } else {
        // Direct path: single positioned write.
        // saving stuff to a file reliably is hard!
        // if you would like to explore and learn more, then
        // start from here: https://danluu.com/file-consistency/
        // and read this too: https://lwn.net/Articles/457667/
        position = _writePosition;
        _writePosition += data.length;
        await _file.write(data, 0, data.length, position);
      }

      if (fsync) {
        await _file.sync();
      }

      _keyDir.set(key, new KeyEntry(ts, position, data.length));
    };

    return queue !== null ? queue.enqueue(inner) : inner();
  }

  /**
   * get retrieves the value from the disk and returns. If the key does not exist
   * then it returns undefined
   *
   * @param key
   */
  async function get(key: string): Promise<string | undefined> {
    // How get works?
    // 1. Check if there is any KeyEntry record for the key in KeyDir
    // 2. Return undefined string if key doesn't exist
    // 3. If it exists, then read KeyEntry.size bytes starting from the
    //    KeyEntry.position from the disk
    // 4. Decode the bytes into valid KV pair and return the value

    const entry = _keyDir.get(key);

    if (!entry) {
      return undefined;
    }

    const buffer = Buffer.alloc(entry.size);
    await _file.read(buffer, 0, entry.size, entry.position);

    const [_, _key, value] = decodeKV(buffer, 0);

    return value;
  }

  async function close(): Promise<void> {
    // Drain any in-flight or queued writes before touching the file handle.
    // WriteQueue: enqueue a no-op that rides the tail of the chain; it resolves
    // only after every earlier fn() has completed (or failed).
    // GroupCommitWriter: drain() resolves once flushing=false and pending=[].
    if (queue !== null) await queue.enqueue(async () => {});
    if (gcWriter !== null) await gcWriter.drain();
    await _file.sync();
    await _file.close();
  }

  return {
    get,
    set,
    close,
  };
}
