# CaskDB - Disk based Log Structured Hash Table Store (Node.js)

> [!NOTE]
> This is a fork from [py-caskdb](https://github.com/avinassh/py-caskdb) ported to Node.js for those not familar with python.

![GitHub License](https://img.shields.io/github/license/JayJamieson/node-caskdb)
[![twitter@iavins](https://img.shields.io/twitter/follow/iavins?style=social)](https://twitter.com/iavins)
[![twitter@iavins](https://img.shields.io/twitter/follow/_JayTheDev?style=social)](https://twitter.com/_JayTheDev)

![architecture](https://user-images.githubusercontent.com/640792/167299554-0fc44510-d500-4347-b680-258e224646fa.png)

CaskDB is a disk-based, embedded, persistent, key-value store based on the [Riak's bitcask paper](https://riak.com/assets/bitcask-intro.pdf), written in Node.js. It is more focused on the educational capabilities than using it in production. The file format is platform, machine, and programming language independent. Say, the database file created from Node.js on macOS should be compatible with Rust on Windows.

This project aims to help anyone, even a beginner in databases, build a persistent database in a few hours. There are no external dependencies; only the Node.js standard library is enough.

If you are interested in writing the database yourself, head to the workshop section.

## Features

- Low latency for reads and writes
- High throughput
- Easy to back up / restore
- Simple and easy to understand
- Store data much larger than the RAM

## Limitations

Most of the following limitations are of CaskDB. However, there are some due to design constraints by the Bitcask paper.

- Single file stores all data, and deleted keys still take up the space
- CaskDB does not offer range scans
- CaskDB requires keeping all the keys in the internal memory. With a lot of keys, RAM usage will be high
- Slow startup time since it needs to load all the keys in memory

## Community

[![CaskDB Discord](https://img.shields.io/discord/851000331721900053)](https://discord.gg/HzthUYkrPp)

Consider joining the Discord community to build and learn KV Store with peers.

## Dependencies

CaskDB does not require any external libraries to run. For local development, install the packages from [package.json](package.json):

`npm install`

## Usage

```ts
const disk: DiskStorage = new DiskStore("books.db");
disk.set("othello", "shakespeare");
const author: string = disk.get("othello");
```

## Prerequisites

The workshop is for intermediate-advanced programmers. Knowing Python is not a requirement, and you can build the database in any language you wish.

Not sure where you stand? You are ready if you have done the following in any language:

- If you have used a dictionary or hash table data structure
- Converting an object (class, struct, or dict) to JSON and converting JSON back to the things
- Open a file to write or read anything. A common task is dumping a dictionary contents to disk and reading back

### Tasks

1. Read [the paper](https://riak.com/assets/bitcask-intro.pdf). Fork this repo and checkout the `start-here` branch
2. Implement the fixed-sized header, which can encode timestamp (uint, 4 bytes), key size (uint, 4 bytes), value size (uint, 4 bytes) together
3. Implement the key, value serialisers, and pass the tests from `src/format.test.ts`
4. Figure out how to store the data on disk and the row pointer in the memory. Implement the get/set operations. Tests for the same are in `store-disk.test.ts`
5. Code from the task #2 and #3 should be enough to read an existing CaskDB file and load the keys into memory

Use `npm run lint` to run eslint. Run `npm test` to run the tests locally.

Not sure how to proceed? Then check the [hints](hints.md) file which contains more details on the tasks and hints.

### Hints

- Check out the documentation of [Buffer](https://nodejs.org/api/buffer.html) for binary serialisation methods in Node.js
- Not sure how to come up with a file format? Read the comment in the [format module](format.ts)

## What next?

I often get questions about what is next after the basic implementation. Here are some challenges (with different levels of difficulties)

### Level 1

- Crash safety: the bitcask paper stores CRC in the row, and while fetching the row back, it verifies the data
- Key deletion: CaskDB does not have a delete API. Read the paper and implement it
- Instead of using a hash table, use a data structure like the red-black tree to support range scans
- CaskDB accepts only strings as keys and values. Make it generic and take other data structures like int or bytes.
- While startup, current implementation loads values into memory. This is unnecessary and can be avoided. Just skip the value bytes and reading just the keys enough to build KeyDir

### Level 2

- Hint file to improve the startup time. The paper has more details on it
- Implement an internal cache which stores some of the key-value pairs. You may explore and experiment with different cache eviction strategies like LRU, LFU, FIFO etc.
- Split the data into multiple files when the files hit a specific capacity

### Level 3

- Support for multiple processes
- Garbage collector: keys which got updated and deleted remain in the file and take up space. Write a garbage collector to remove such stale data
- Add SQL query engine layer
- Store JSON in values and explore making CaskDB as a document database like Mongo
- Make CaskDB distributed by exploring algorithms like raft, paxos, or consistent hashing

## Contributing

All contributions are welcome. Please check [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## License

The MIT license. Please check `LICENSE` for more details.
