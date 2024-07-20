import { expect, suite, test } from "vitest";
import {
  decodeHeader,
  decodeKV,
  encodeHeader,
  encodeKV,
  HEADER_SIZE,
  KeyEntry,
} from "./format.js";
import { randomInt, randomUUID } from "node:crypto";

function getRandomHeader(): [number, number, number] {
  const maxSize = 2 ** 32 - 1;
  return [randomInt(maxSize), randomInt(maxSize), randomInt(maxSize)];
}

function getRandomKV(): [number, string, string, number] {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = randomUUID();
  const value = randomUUID();

  return [
    timestamp,
    key,
    value,
    HEADER_SIZE + Buffer.byteLength(key) + Buffer.byteLength(value),
  ];
}

class Header {
  constructor(
    public timestamp: number,
    public keySize: number,
    public valueSize: number
  ) {}
}

class KeyValue {
  constructor(
    public timestamp: number,
    public key: string,
    public value: string,
    public size: number
  ) {}
}

suite("header op", () => {
  const testHeader = (header: Header) => {
    const buffer = Buffer.alloc(HEADER_SIZE);
    encodeHeader(buffer, header.timestamp, header.keySize, header.valueSize);

    const [t, k, v] = decodeHeader(buffer);

    expect(t).toBe(header.timestamp);
    expect(k).toBe(header.keySize);
    expect(v).toBe(header.valueSize);
  };

  test("header serialisation", () => {
    const headers = [
      new Header(10, 10, 10),
      new Header(0, 0, 0),
      new Header(100, 100, 100),
    ];

    for (const header of headers) {
      testHeader(header);
    }
  });

  test("random", () => {
    for (let index = 0; index <= 100; index++) {
      const header = new Header(...getRandomHeader());
      testHeader(header);
    }
  });

  test("bad", () => {
    const buffer = Buffer.alloc(HEADER_SIZE);
    expect(() => {
      encodeHeader(buffer, Math.pow(2, 32), 5, 3);
    }).toThrow();
  });
});

suite("encode kv", () => {
  const testKV = (keyvalue: KeyValue) => {
    const data = encodeKV(keyvalue.timestamp, keyvalue.value, keyvalue.value);

    const [t, k, v] = decodeKV(data);

    expect(t).toBe(keyvalue.timestamp);
    expect(k).toBe(keyvalue.value);
    expect(v).toBe(keyvalue.value);
    expect(data.length).toBe(keyvalue.size);
  };

  test("kv serialisation", () => {});

  test("random", () => {
    for (let index = 0; index <= 100; index++) {
      const header = new KeyValue(...getRandomKV());
      testKV(header);
    }
  });
});

suite("key entry", () => {
  // dumb test to increase the coverage
  test("init", () => {
    const ke = new KeyEntry(10, 10, 10);
    expect(ke.timestamp).toBe(10);
    expect(ke.position).toBe(10);
    expect(ke.size).toBe(10);
  });
});
