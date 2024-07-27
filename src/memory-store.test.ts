import { expect, suite, test } from "vitest";
import { MemoryStorage } from "./memory-store.js";

suite("in memory caskdb", () => {
  test("get()", async () => {
    const store = MemoryStorage();
    await store.set("name", "jojo");
    const result = await store.get("name");

    expect(result).toBe("jojo");
  });

  test("invalid key", async () => {
    const store = MemoryStorage();

    const result = await store.get("name");

    expect(result).toBe(undefined);
  });

  test("close()", async () => {
    const store = MemoryStorage();
    await store.close();
  });
});
