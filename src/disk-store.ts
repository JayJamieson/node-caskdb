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

import { open } from "node:fs/promises";
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

export async function DiskStorage(path: string): Promise<DiskStore> {
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

    console.log("****----------initialising the database----------****");
    let offset = 0;
    while (offset < readResult.bytesRead) {
      const [timestamp, keySize, valueSize] = decodeHeader(buffer, offset);
      const entrySize = HEADER_SIZE + keySize + valueSize;

      const key = buffer.toString(
        "utf8",
        offset + HEADER_SIZE,
        offset + HEADER_SIZE + keySize
      );

      const value = buffer.toString(
        "utf8",
        offset + HEADER_SIZE + keySize,
        offset + HEADER_SIZE + keySize + valueSize
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
    console.log("****----------initialisation complete----------****");
  }

  /**
   * set stores the key and value on the disk
   * @param key
   * @param value
   */
  async function set(key: string, value: string): Promise<void> {
    // The steps to save a KV to disk is simple:
    // 1. Encode the KV into bytes
    // 2. Write the bytes to disk by appending to the file
    // 3. Update KeyDir with the KeyEntry of this key
    const ts = timestamp();
    const data = encodeKV(ts, key, value);

    // saving stuff to a file reliably is hard!
    // if you would like to explore and learn more, then
    // start from here: https://danluu.com/file-consistency/
    // and read this too: https://lwn.net/Articles/457667/
    await _file.write(data);

    // calling fsync after every write is important, this assures that our writes
    // are actually persisted to the disk
    await _file.sync();

    const entry = new KeyEntry(ts, _writePosition, data.length);
    _keyDir.set(key, entry);

    // update last write position, so that next record can be written from this point
    _writePosition += data.length;
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
    await _file.sync();
    await _file.close();
  }

  return {
    get,
    set,
    close,
  };
}
