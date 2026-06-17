import type { NodeView } from "../api/types";
import { StatusPill, toneForStatus } from "./controls";

export function RunGraph({ nodes }: { nodes: NodeView[] }) {
  if (nodes.length === 0) {
    return <div className="graph-empty">No journal nodes have been recorded.</div>;
  }

  return (
    <div className="graph-canvas" aria-label="Run graph">
      {nodes.map((node) => (
        <div className="graph-node" key={`${node.stableKey}:${node.attempt}`}>
          <div className="graph-node-main">
            <span className="mono graph-key">{node.stableKey}</span>
            <StatusPill tone={toneForStatus(node.status)}>{node.status}</StatusPill>
          </div>
          <div className="graph-node-meta">
            <span>{node.effectType}</span>
            <span>attempt {node.attempt}</span>
            {node.artifactBacked ? <span>artifact</span> : null}
          </div>
          <div className="graph-deps">
            {node.dependsOn.length === 0
              ? "root"
              : node.dependsOn.map((dep) => (
                  <span className="dep-pill mono" key={dep}>
                    {dep}
                  </span>
                ))}
          </div>
        </div>
      ))}
    </div>
  );
}
