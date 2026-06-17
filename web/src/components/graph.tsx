import type { NodeView } from "../api/types";
import { StatusPill, formatTime, toneForStatus } from "./controls";

interface LayoutNode {
  node: NodeView;
  level: number;
}

export function RunGraph({ nodes }: { nodes: NodeView[] }) {
  if (nodes.length === 0) {
    return <div className="graph-empty">No journal nodes have been recorded.</div>;
  }

  const layout = layoutNodes(nodes);
  const levels = groupByLevel(layout);
  const edgeCount = nodes.reduce((count, node) => count + node.dependsOn.length, 0);

  return (
    <div className="graph-hybrid" aria-label="Run graph from projection nodes">
      <div className="graph-summary">
        <StatusPill tone="info">{nodes.length} nodes</StatusPill>
        <StatusPill tone="neutral">{edgeCount} dependencies</StatusPill>
      </div>
      <div className="graph-board">
        {levels.map((level) => (
          <section className="graph-lane" key={level.level}>
            <h3>Stage {level.level + 1}</h3>
            <div className="graph-lane-nodes">
              {level.nodes.map(({ node }) => (
                <GraphNode node={node} key={`${node.stableKey}:${node.attempt}`} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function NodeTimeline({ nodes }: { nodes: NodeView[] }) {
  if (nodes.length === 0) {
    return <div className="table-empty">No projected nodes are available.</div>;
  }

  return (
    <ol className="node-timeline" aria-label="Node timeline">
      {sortNodes(nodes).map((node) => (
        <li className="node-timeline-item" key={`${node.stableKey}:${node.attempt}`}>
          <span className={`timeline-dot dot-${toneForStatus(node.status)}`} />
          <div className="node-timeline-body">
            <div className="node-timeline-main">
              <span className="mono">{node.stableKey}</span>
              <StatusPill tone={toneForStatus(node.status)}>{node.status}</StatusPill>
            </div>
            <div className="node-timeline-meta">
              <span>{formatTime(node.startedAtMs)}</span>
              <span>{node.effectType}</span>
              <span>attempt {node.attempt}</span>
              {node.artifactBacked ? <span>artifact backed</span> : null}
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
        </li>
      ))}
    </ol>
  );
}

function GraphNode({ node }: { node: NodeView }) {
  return (
    <div className="graph-node">
      <div className="graph-node-main">
        <span className="mono graph-key">{node.stableKey}</span>
        <StatusPill tone={toneForStatus(node.status)}>{node.status}</StatusPill>
      </div>
      <div className="graph-node-meta">
        <span>{node.effectType}</span>
        <span>attempt {node.attempt}</span>
        <span>{formatTime(node.startedAtMs)}</span>
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
  );
}

function layoutNodes(nodes: NodeView[]): LayoutNode[] {
  const byKey = new Map(nodes.map((node) => [node.stableKey, node]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const levelFor = (node: NodeView): number => {
    const existing = memo.get(node.stableKey);
    if (existing !== undefined) return existing;
    if (visiting.has(node.stableKey)) return 0;
    visiting.add(node.stableKey);
    const level =
      node.dependsOn.length === 0
        ? 0
        : Math.max(
            0,
            ...node.dependsOn.map((dep) => {
              const parent = byKey.get(dep);
              return parent ? levelFor(parent) + 1 : 0;
            }),
          );
    visiting.delete(node.stableKey);
    memo.set(node.stableKey, level);
    return level;
  };

  return sortNodes(nodes).map((node) => ({ node, level: levelFor(node) }));
}

function groupByLevel(layout: LayoutNode[]): Array<{ level: number; nodes: LayoutNode[] }> {
  const grouped = new Map<number, LayoutNode[]>();
  for (const item of layout) {
    const current = grouped.get(item.level) ?? [];
    current.push(item);
    grouped.set(item.level, current);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([level, levelNodes]) => ({ level, nodes: levelNodes }));
}

function sortNodes(nodes: NodeView[]): NodeView[] {
  return nodes.slice().sort((a, b) => {
    const timeA = a.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    const timeB = b.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    if (timeA !== timeB) return timeA - timeB;
    return a.stableKey.localeCompare(b.stableKey);
  });
}
