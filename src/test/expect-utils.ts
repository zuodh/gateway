import sleep from '../sleep';

export function waitForExpect(expect: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let wait = 2500;
    const interval = 500;
    const retry = async () => {
      try {
        await expect();
        resolve();
        return;
      } catch (err) {
        wait -= interval;
        if (wait <= 0) {
          reject(err);
          return;
        }
        await sleep(interval);
        retry();
      }
    };
    retry();
  });
}
