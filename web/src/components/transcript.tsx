import type { EventStreamFrame } from "../api/types";
import { StatusPill, formatTime, toneForStatus } from "./controls";

export function Transcript({ events }: { events: EventStreamFrame[] }) {
  if (events.length === 0) return <div className="table-empty">No events in the current tail.</div>;

  return (
    <div className="event-list">
      {events.map((event, index) => {
        const key = "seq" in event ? `${event.kind}:${event.seq}` : `${event.kind}:${index}`;
        const type = event.type;
        return (
          <div className="event-row" key={key}>
            <div className="event-time mono">{"atMs" in event ? formatTime(event.atMs) : "-"}</div>
            <StatusPill tone={toneForStatus(type)}>{type}</StatusPill>
            <pre>{JSON.stringify("payload" in event ? event.payload : event, null, 2)}</pre>
          </div>
        );
      })}
    </div>
  );
}
