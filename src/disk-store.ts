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
   * set stores the key and value on the disk
   * @param key
   * @param value
   */
  async function set(key: string, value: string): Promise<void> {
    throw new Error("Not implemented");
  }

  /**
   * get retrieves the value from the disk and returns. If the key does not exist
   * then it returns undefined
   *
   * @param key
   */
  async function get(key: string): Promise<string | undefined> {
    throw new Error("Not implemented");
  }

  async function close(): Promise<void> {
    throw new Error("Not implemented");
  }

  return {
    get,
    set,
    close,
  };
}
