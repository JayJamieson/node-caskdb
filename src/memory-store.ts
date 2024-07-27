/*

**Note**
It's probably not necessary to use promises for the MemoryStorage implementation since the underlying memory
store is just a Map that isn't async.

Feel free opt out of using Promises/async/await in your own implementation. Be sure to update the tests to account for this
change.
*/

export type MemoryStore = {
  set: (key: string, value: string) => Promise<void>;
  get: (key: string) => Promise<string | undefined>;
  close: () => Promise<void>;
};

export function MemoryStorage(): MemoryStore {
  const keyDir = new Map<string, string>();

  function set(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      keyDir.set(key, value);
      resolve();
    });
  }

  function get(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      resolve(keyDir.get(key));
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve) => {
      resolve(keyDir.clear());
    });
  }

  return {
    get,
    set,
    close,
  };
}
