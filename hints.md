# Hints

_contains spoilers, proceed with caution!_

## Tests

Below is the order in which you should pass the tests:

1. `test header op`
2. `test encode kv`
3. `test disk CaskDB`
4. `test disk CaskDB existing file`

## Tasks

I have relisted the tasks here again, but with more details. If you have difficulty understanding the steps, the following should help you.

### Read the paper

The word 'paper' might scare you, but [Bitcask's paper](https://riak.com/assets/bitcask-intro.pdf) is very approachable. It is only six pages long, half of them being diagrams.

### Header

| Test | test header op |
|------|--------------|

The next step is to implement a fixed-sized header similar to Bitcask. Every record in our DB contains a header holding metadata and helps our DB read values from the disk. The DB will read a bunch of bytes from the disk, so we need information on how many bytes to read and from which byte offset.

**Some more details:**

The header contains three fields timestamp, key size, and value size.

| Field      | Type | Size |
|------------|------|------|
| timestamp  | int  | 4B   |
| key_size   | int  | 4B   |
| value_size | int  | 4B   |

We need to implement a function which takes all these three fields and serialises them to bytes. The function signature looks like this:

```ts
function encodeHeader(buffer: Buffer, timestamp: number, keySize: number, valueSize: number): void
```

Then we also need to write the opposite of the above:

```ts
function decodeHeader(data: Buffer): [number, number, number]
```

**More Hints:**

- Read this [comment](https://github.com/avinassh/py-caskdb/blob/e0819f7/format.py#L1,#L37) to understand why do we need serialiser methods
- Check out the documentation of [`Buffer`](https://nodejs.org/api/buffer.html) for serialisation methods in Node.js
- Not sure how to come up with a file format? Read the comment in the [format module](https://github.com/avinassh/py-caskdb/blob/e0819f7/format.py#L42,#L74)

### Key Value Serialisers

| Test | test encode kv |
|------|--------------|

Now we will write encode and decode methods for key and value.

The method signatures:

```ts
function encodeKV(timestamp: number, key: string, value: string): [number, Buffer]
function decodeKV(data: bytes): [number, string, string]
```

Note that `encodeKV` method returns the bytes and the bytes' size.

### Storing to Disk

| Test | test disk CaskDB |
|------|----------------|

This step involves figuring out the persistence layer, saving the data to the disk, and keeping the pointer to the inserted record in the memory.

So, implement the `DiskStorage` class in `disk-store.ts`

**Hints:**

- Some meta info on the DiskStorage is [here](https://github.com/avinassh/py-caskdb/blob/e0819f7/disk_store.py#L1,L21).
- The inner workings of the DiskStorage are [here](https://github.com/avinassh/py-caskdb/blob/e0819f7/disk_store.py#L41,L65).

### Start up tasks

| Test | test disk CaskDB existing file |
|------|----------------------------|

DiskStorage is a persistent key-value store, so we need to load the existing keys into the `KeyDir` at the start of the database.
