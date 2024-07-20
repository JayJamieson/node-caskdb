/*
format module provides encode/decode functions for serialisation and deserialisation
operations

format module is generic and does not have any disk or memory specific code.

The disk storage deals with bytes; you cannot just store a string or object without
converting it to bytes. The programming languages provide abstractions where you
don't have to think about all this when storing things in memory (i.e. RAM).
Consider the following example where you are storing stuff in a hash table:

    const books = {}
    books["hamlet"] = "shakespeare"
    books["anna karenina"] = "tolstoy"

In the above, the language deals with all the complexities:

    - allocating space on the RAM so that it can store data of `books`
    - whenever you add data to `books`, convert that to bytes and keep it in the memory
    - whenever the size of `books` increases, move that to somewhere in the RAM so that
      we can add new items

Unfortunately, when it comes to disks, we have to do all this by ourselves, write
code which can allocate space, convert objects to/from bytes and many other operations.

format module provides two functions which help us with serialisation of data.

    encodeKV - takes the key value pair and encodes them into bytes
    decodeKV - takes a bunch of bytes and decodes them into key value pairs

**workshop note**

 For the workshop, the functions will have the following signature:

    function encodeKV(buffer: Buffer, timestamp: number, key: string, value: string): void
    function decodeKV(data: Buffer): [int, string, string]

Our key value pair, when stored on disk looks like this:
    ┌───────────┬──────────┬────────────┬─────┬───────┐
    │ timestamp │ key_size │ value_size │ key │ value │
    └───────────┴──────────┴────────────┴─────┴───────┘

This is analogous to a typical database's row (or a record). The total length of
the row is variable, depending on the contents of the key and value.

The first three fields form the header:
    ┌───────────────┬──────────────┬────────────────┐
    │ timestamp(4B) │ key_size(4B) │ value_size(4B) │
    └───────────────┴──────────────┴────────────────┘

These three fields store unsigned integers of size 4 bytes, giving our header a
fixed length of 12 bytes. Timestamp field stores the time the record we
inserted in unix epoch seconds. Key size and value size fields store the length of
bytes occupied by the key and value. The maximum integer
stored by 4 bytes is 4,294,967,295 (2 ** 32 - 1), roughly ~4.2GB. So, the size of
each key or value cannot exceed this. Theoretically, a single row can be as large
as ~8.4GB.

We use `Buffer.writeUInt32LE` method to serialise our header to bytes. `buffer.writeUInt32LE` function
looks like this:

  buffer.writeUInt32LE(value, offset)

The first argument is a number value, which is your value to encode as binary.
Check the buffer documentation https://nodejs.org/api/buffer.html
to understand how to encode numeric/string data into buffers.
*/

export const HEADER_SIZE = 12;

export class KeyEntry {
  /**
   * KeyEntry keeps the metadata about the KV, specially the position of
   * the byte offset in the file. Whenever we insert/update a key, we create a new
   * KeyEntry object and insert that into KeyDir.
   *
   * @param timestamp Timestamp at which we wrote the KV pair to the disk. The value is current time in seconds since the epoch.
   * @param position The position is the byte offset in the file where the data exists
   * @param size Total size of bytes of the value. We use this value to know how many bytes we need to read from the file
   */
  constructor(
    public timestamp: number,
    public position: number,
    public size: number
  ) {}
}

/**
 * encodeHeader encodes the data into bytes using the `HEADER_FORMAT` format.
 *
 * @param buff buffer to encode header into
 * @param timestamp Timestamp at which we wrote the KV pair to the disk. The value is current time in seconds since the epoch.
 * @param kSize size of the key (cannot exceed the maximum)
 * @param vSize size of the value (cannot exceed the maximum)
 */
export function encodeHeader(
  buff: Buffer,
  timestamp: number,
  kSize: number,
  vSize: number
) {
  buff.writeUInt32LE(timestamp, 0);
  buff.writeUInt32LE(kSize, 4);
  buff.writeUInt32LE(vSize, 8);
}

/**
 * decodes the buffer into header using the `HEADER_FORMAT` format
 *
 * @param buffer buffer container header data to decode
 * @param offset from where to decode header data
 * @returns A 3 element array containing: [timestamp, keySize, valueSize]
 */
export function decodeHeader(
  buffer: Buffer,
  offset: number = 0
): [number, number, number] {
  return [
    buffer.readUInt32LE(offset),
    buffer.readUInt32LE(offset + 4),
    buffer.readUInt32LE(offset + 8),
  ];
}

/**
 * encodes the KV pair into buffer
 *
 * @param timestamp Timestamp at which we wrote the KV pair to the disk. The value is current time in seconds since the epoch.
 * @param key cannot exceed the maximum size 2^31
 * @param value cannot exceed the maximum size 2^31
 * @returns buffer of encoded data
 */
export function encodeKV(
  timestamp: number,
  key: string,
  value: string
): Buffer {
  const kSize = Buffer.byteLength(key);
  const vSize = Buffer.byteLength(value);

  const buff = Buffer.alloc(HEADER_SIZE + kSize + vSize);
  encodeHeader(buff, timestamp, kSize, vSize);

  buff.write(`${key}${value}`, HEADER_SIZE);

  return buff;
}

/**
 * decodes the buffer into appropriate KV pair
 *
 * @param buff buffer containing the encoded KV data
 * @param offset from where to decode data
 * @returns 3 element array containing [timestamp, key, value]
 */
export function decodeKV(
  buff: Buffer,
  offset: number = 0
): [number, string, string] {
  const [timestamp, kSize, vSize] = decodeHeader(buff, offset);

  const key = buff.toString("utf8", HEADER_SIZE, HEADER_SIZE + kSize);
  const value = buff.toString(
    "utf8",
    HEADER_SIZE + kSize,
    HEADER_SIZE + kSize + vSize
  );

  return [timestamp, key, value];
}
