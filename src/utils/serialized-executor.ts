export type SerializedExecutor = <Result>(task: () => Promise<Result>) => Promise<Result>;

export function createSerializedExecutor(): SerializedExecutor {
  let tail = Promise.resolve();

  return async <Result>(task: () => Promise<Result>): Promise<Result> => {
    const previous = tail;
    let release: (() => void) | undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      if (!release) throw new Error('Serialized executor release callback was not initialized.');
      release();
    }
  };
}
