import type { JournalStore } from "../journal/store.ts";
import type { EventRow } from "../journal/types.ts";
import type { EventEnvelope } from "./contract.ts";

type Subscriber = (event: EventEnvelope) => void;

export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(store: JournalStore, runId: string, afterSeq: number, onEvent: Subscriber): () => void {
    const deliveredDurableSeqs = new Set<number>();
    const buffered: EventEnvelope[] = [];
    let backfilling = true;
    let flushing = false;
    let stopped = false;
    const deliver = (event: EventEnvelope): void => {
      if (stopped) return;
      if (event.kind === "durable") {
        if (event.seq <= afterSeq || deliveredDurableSeqs.has(event.seq)) return;
        deliveredDurableSeqs.add(event.seq);
      }
      if (backfilling || flushing) buffered.push(event);
      else onEvent(event);
    };
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(deliver);
    for (const ev of store.listEvents(runId, afterSeq)) {
      deliver(durableEnvelope(ev));
    }
    backfilling = false;
    flushing = true;
    for (let i = 0; i < buffered.length; i++) {
      if (stopped) break;
      const event = buffered[i];
      if (event) onEvent(event);
    }
    flushing = false;
    return () => {
      stopped = true;
      set?.delete(deliver);
      if (set?.size === 0) this.subscribers.delete(runId);
    };
  }

  publishDurable(event: EventRow): void {
    this.publish(event.runId, durableEnvelope(event));
  }

  publishEphemeral(runId: string, type: string, payload: unknown, atMs: number): void {
    this.publish(runId, { kind: "ephemeral", type, payload, atMs });
  }

  private publish(runId: string, event: EventEnvelope): void {
    const set = this.subscribers.get(runId);
    if (!set) return;
    for (const subscriber of [...set]) {
      try {
        subscriber(event);
      } catch {
        // One watcher must not break delivery to other watchers or journal commits.
      }
    }
  }
}

function durableEnvelope(event: EventRow): EventEnvelope {
  return {
    kind: "durable",
    seq: event.seq,
    type: event.type,
    payload: JSON.parse(event.payloadJson),
    atMs: event.emittedAtMs,
  };
}
