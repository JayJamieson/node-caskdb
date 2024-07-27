import { DiskStorage } from "./disk-store.js";
import { MemoryStorage } from "./memory-store.js";

async function memoryDB() {
  const store = MemoryStorage();

  console.log(await store.get("name"));
  await store.set("name", "jojo");
  console.log(await store.get("name"), "jojo");
}

async function storeDB(): Promise<void> {
  const store = await DiskStorage("data.db");
  // on the first run, this will print empty string, but on the next run
  // it should print the value from the disk
  console.log(await store.get("name"));
  store.set("name", "haha");
  console.log(await store.get("name"));
  store.close();
}

async function storeBook(): Promise<void> {
  const store = await DiskStorage("books.db");
  const books: Record<string, string> = {
    "crime and punishment": "dostoevsky",
    "anna karenina": "tolstoy",
    "war and peace": "tolstoy",
    hamlet: "shakespeare",
    othello: "shakespeare",
    "brave new world": "huxley",
    dune: "frank herbert",
  };

  for (const [k, v] of Object.entries(books)) {
    await store.set(k, v);

    console.log(`set k=${k}, v=${v}`);
    console.log(`get k=${k}, v=${await store.get(k)}`);
  }

  for (const [k, _] of Object.entries(books)) {
    console.log(`get k=${k}, v=${await store.get(k)}`);
  }

  await store.close();
}

async function main() {
  console.log("Memory DB");
  await memoryDB();

  console.log("Store DB");
  await storeDB();

  console.log("Store Book DB");
  await storeBook();
}

await main();
