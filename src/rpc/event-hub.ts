import type { JournalStore } from "../journal/store.ts";
import type { EventRow } from "../journal/types.ts";
import type { EventEnvelope, StreamControlFrame, SubscribeEventsRequest } from "./contract.ts";
import { closedWatchStatus, cursorAfterSeq, resolveEventCursor } from "./event-cursor.ts";

type Subscriber = (event: EventEnvelope) => void;
type ControlSubscriber = (frame: StreamControlFrame) => void;

export interface EventHubSubscription {
  unsubscribe: () => void;
  cursor: { kind: "after-seq"; runId: string; seq: number };
  closedStatus: string | null;
}

export class EventHub {
  private readonly subscribers = new Map<string, Set<Subscriber>>();

  subscribe(
    store: JournalStore,
    req: SubscribeEventsRequest,
    onEvent: Subscriber,
    onControl?: ControlSubscriber,
  ): EventHubSubscription {
    const { runId } = req;
    const resolved = resolveEventCursor(store, runId, req.cursor);
    const afterSeq = resolved.afterSeq;
    const deliveredDurableSeqs = new Set<number>();
    const buffered: EventEnvelope[] = [];
    let backfilling = true;
    let flushing = false;
    let stopped = false;
    let highestDurableSeq = afterSeq;
    const deliver = (event: EventEnvelope): void => {
      if (stopped) return;
      if (event.kind === "durable") {
        if (event.seq <= afterSeq || deliveredDurableSeqs.has(event.seq)) return;
        deliveredDurableSeqs.add(event.seq);
        highestDurableSeq = Math.max(highestDurableSeq, event.seq);
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
    const cursor = cursorAfterSeq(runId, Math.max(afterSeq, highestDurableSeq));
    const run = store.getRun(runId);
    const closedStatus = run ? closedWatchStatus(run.status) : null;
    onControl?.({ kind: "control", type: "caught-up", cursor });
    if (closedStatus) {
      onControl?.({ kind: "control", type: "closed", cursor, status: closedStatus });
    }
    const unsubscribe = () => {
      stopped = true;
      set?.delete(deliver);
      if (set?.size === 0) this.subscribers.delete(runId);
    };
    return { unsubscribe, cursor, closedStatus };
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
