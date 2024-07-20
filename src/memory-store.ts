/*

**Note**
It's probably not necessary to use promises for the MemoryStorage implementation since the underlying memory
store is just a Map that isn't async.

Feel free opt out of using Promises/async/await in your own implementation. Be sure to update the tests to account for this
change.
*/

export class MemoryStorage {
  private keyDir: Map<string, string>;

  constructor() {
    this.keyDir = new Map<string, string>();
  }

  set(key: string, value: string): Promise<void> {
    return new Promise((resolve) => {
      this.keyDir.set(key, value);
      resolve();
    });
  }

  get(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      resolve(this.keyDir.get(key));
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      resolve(this.keyDir.clear());
    });
  }
}
