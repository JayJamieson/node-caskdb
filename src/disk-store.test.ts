import { afterAll, expect, suite, test } from "vitest";
import { DiskStorage } from "./disk-store.js";

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
