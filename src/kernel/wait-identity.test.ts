// Commit 5: durable-wait stable identity — keyed sleeps, duration-versioned
// timers, and per-name signal occurrence keys.

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { RealmKernel } from "./realm/realm-host.ts";

const multiSleepUrl = new URL("./realm/fixtures/multi-sleep.workflow.ts", import.meta.url).pathname;
const multiSignalUrl = new URL("./realm/fixtures/multi-signal.workflow.ts", import.meta.url)
  .pathname;

describe("keyed durable sleeps", () => {
  test("two sleeps park/wake under distinct stable keys", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const clock = () => t;
    const kernel = new RealmKernel(store, { idgen: () => "r", clock });

    // parks at first-nap
    let h = await kernel.run<number>(multiSleepUrl, null, { name: "ms" });
    expect(h.status).toBe("waiting-timer");
    let timers = store.db
      .query<{ stable_key: string }, []>("SELECT stable_key FROM timers WHERE run_id='r'")
      .all();
    expect(timers.map((x) => x.stable_key)).toEqual(["first-nap#100"]);

    // wake first → runs to the second sleep, parks again under second-nap
    t = 150;
    h = await kernel.resume<number>("r", multiSleepUrl);
    expect(h.status).toBe("waiting-timer");
    timers = store.db
      .query<{ stable_key: string }, []>("SELECT stable_key FROM timers WHERE run_id='r'")
      .all();
    expect(timers.map((x) => x.stable_key).sort()).toEqual(["first-nap#100", "second-nap#200"]);

    // wake second → finishes
    t = 400;
    h = await kernel.resume<number>("r", multiSleepUrl);
    expect(h.status).toBe("finished");
    expect(h.output).toBe(2);
  });

  test("the timer key folds in the duration (changing it is a new timer)", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { idgen: () => "r", clock: () => 0 });
    await kernel.run(multiSleepUrl, null, { name: "ms" });
    const key = store.db
      .query<{ stable_key: string }, []>("SELECT stable_key FROM timers WHERE run_id='r'")
      .get()?.stable_key;
    expect(key).toBe("first-nap#100"); // duration is part of identity
  });
});

describe("per-name signal occurrence keys", () => {
  test("two 'event' signals + one 'other' consume in order, robust to keying", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { idgen: () => "r" });

    let h = await kernel.run<number[]>(multiSignalUrl, null, { name: "sig" });
    expect(h.status).toBe("waiting-signal");

    store.putSignal("r", "event", 10, 1);
    store.putSignal("r", "event", 20, 2);
    store.putSignal("r", "other", 30, 3);
    h = await kernel.resume<number[]>("r", multiSignalUrl);
    expect(h.status).toBe("finished");
    expect(h.output).toEqual([10, 20, 30]);

    // the consumed keys are name:occurrence, not global ordinals
    const consumed = store.db
      .query<{ consumed_key: string }, []>(
        "SELECT consumed_key FROM signals WHERE run_id='r' ORDER BY seq",
      )
      .all()
      .map((x) => x.consumed_key);
    expect(consumed).toEqual(["event:0", "event:1", "other:0"]);
  });
});
