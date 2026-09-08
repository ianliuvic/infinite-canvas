import { resolveImageUrl } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";

/** Persisted blob URLs belong to an earlier page; resolve the durable key before insertion. */
export async function resolveAssetMediaUrl(kind: "image" | "video", storageKey: string | undefined, fallback: string): Promise<string> {
    const url = storageKey ? await (kind === "image" ? resolveImageUrl(storageKey) : resolveMediaUrl(storageKey)) : fallback;
    if (!url) throw new Error("资产媒体暂时无法读取，请稍后重试。未添加失效节点，原资产保持不变。");
    return url;
}
