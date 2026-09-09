import { importRemoteImage } from "@/services/remote-storage";
import { resolveAssetMediaUrl } from "@/services/asset-media";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";

export async function persistExternalImages(
    entries: { nodeId: string; url?: string }[],
    current: () => CanvasAgentSnapshot | null | undefined,
    apply: (ops: CanvasAgentOp[]) => unknown,
) {
    const initial = current();
    if (!initial) throw new Error("请先打开目标画布");
    if (!entries.length || new Set(entries.map(entry => entry.nodeId)).size !== entries.length) throw new Error("请指定不重复的图片节点");
    const originals = entries.map(entry => {
        const node = initial.nodes.find(node => node.id === entry.nodeId);
        if (!node || node.type !== "image") throw new Error("图片节点不存在：" + entry.nodeId);
        return node;
    });
    const ops: CanvasAgentOp[] = [];
    for (const [index, entry] of entries.entries()) {
        const node = originals[index];
        let stored = { storageKey: node.metadata?.storageKey, bytes: node.metadata?.bytes, mimeType: node.metadata?.mimeType };
        if (entry.url || !stored.storageKey) {
            const source = entry.url || node.metadata?.content || "";
            if (!source.startsWith("https://")) throw new Error("节点 " + node.id + " 没有可用外链，请提供原始 HTTPS 图片 url；不能从失效 blob 猜测来源");
            stored = await importRemoteImage(source);
        }
        const content = await resolveAssetMediaUrl("image", stored.storageKey, "");
        ops.push({ type: "update_node", id: node.id, metadata: { ...stored, content, status: "success" } });
    }
    // Do not overwrite a changed/deleted/replaced node or a newly opened canvas after a slow download.
    const latest = current();
    if (!latest || latest.projectId !== initial.projectId || originals.some(node => {
        const now = latest.nodes.find(item => item.id === node.id);
        return !now || now.type !== "image" || now.metadata?.content !== node.metadata?.content || now.metadata?.storageKey !== node.metadata?.storageKey;
    })) throw new Error("下载期间画布或图片已改变，文件已保留但未覆盖节点；请重新读取画布后操作");
    apply(ops);
    return { ok: true, updatedNodeIds: entries.map(entry => entry.nodeId), addedAssets: 0, addedNodes: 0 };
}
