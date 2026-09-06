import type { CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

type ElkNode = { id: string; x?: number; y?: number; width?: number; height?: number };

/** Arrange a selected scope as a left-to-right directed graph while moving groups as intact units. */
export async function arrangeCanvasNodes(nodes: CanvasNodeData[], connections: CanvasConnection[], requestedIds?: Set<string>) {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const rootId = (id: string) => byId.get(id)?.metadata?.groupId || id;
    const scope = requestedIds?.size
        ? new Set([...requestedIds].map(rootId))
        : new Set(nodes.filter((node) => !node.metadata?.groupId).map((node) => node.id));
    const roots = nodes.filter((node) => scope.has(node.id) && !node.metadata?.groupId);
    if (roots.length < 2) return nodes;

    const rootIds = new Set(roots.map((node) => node.id));
    const edges = connections.flatMap((connection, index) => {
        const source = rootId(connection.fromNodeId);
        const target = rootId(connection.toNodeId);
        return source !== target && rootIds.has(source) && rootIds.has(target) ? [{ id: connection.id || `edge-${index}`, sources: [source], targets: [target] }] : [];
    });
    const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
    const layout = await new ELK().layout({
        id: "root",
        layoutOptions: {
            "elk.algorithm": "layered",
            "elk.direction": "RIGHT",
            "elk.edgeRouting": "ORTHOGONAL",
            "elk.spacing.nodeNode": "80",
            "elk.spacing.componentComponent": "120",
            "elk.layered.spacing.nodeNodeBetweenLayers": "140",
            "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        },
        children: roots.map((node) => ({ id: node.id, width: node.width, height: node.height })),
        edges,
    });
    const positioned = new Map((layout.children || []).map((node: ElkNode) => [node.id, node]));
    const before = boundsOf(roots);
    const after = boundsOf(roots.map((node) => ({ ...node, position: { x: positioned.get(node.id)?.x || 0, y: positioned.get(node.id)?.y || 0 } })));
    const translate = { x: (before.left + before.right - after.left - after.right) / 2, y: (before.top + before.bottom - after.top - after.bottom) / 2 };
    const deltas = new Map(roots.map((node) => {
        const placed = positioned.get(node.id);
        return [node.id, { x: (placed?.x || 0) + translate.x - node.position.x, y: (placed?.y || 0) + translate.y - node.position.y }];
    }));
    return nodes.map((node) => {
        const root = rootId(node.id);
        const delta = deltas.get(root);
        return delta ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } } : node;
    });
}

export function viewportForNodes(nodes: CanvasNodeData[], size: { width: number; height: number }, padding = 80): ViewportTransform | null {
    if (!nodes.length) return null;
    const bounds = boundsOf(nodes);
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const k = Math.min(1, Math.max(0.05, Math.min((size.width - padding * 2) / width, (size.height - padding * 2) / height)));
    return { x: (size.width - width * k) / 2 - bounds.left * k, y: (size.height - height * k) / 2 - bounds.top * k, k };
}

function boundsOf(nodes: CanvasNodeData[]) {
    return nodes.reduce((bounds, node) => ({
        left: Math.min(bounds.left, node.position.x),
        top: Math.min(bounds.top, node.position.y),
        right: Math.max(bounds.right, node.position.x + node.width),
        bottom: Math.max(bounds.bottom, node.position.y + node.height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
}
