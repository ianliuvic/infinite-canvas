import crypto from "node:crypto";
import type { PersistentStorage } from "./persistent-storage.js";

export function validateImageSource(source: string) {
    const url = new URL(source);
    const hosts = (process.env.CANVAS_IMAGE_IMPORT_HOSTS || "wearhongxiu.com,www.wearhongxiu.com").split(",").map(host => host.trim().toLowerCase()).filter(Boolean);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !hosts.includes(url.hostname.toLowerCase())) throw new Error("图片来源未授权；仅支持服务端 CANVAS_IMAGE_IMPORT_HOSTS 配置的 HTTPS 站点");
    return url;
}

/** No browser cookies/auth forwarded, no redirects, and no asset-library mutation. */
export async function importExternalImage(source: string, storage: Pick<PersistentStorage, "putObject">, signal?: AbortSignal) {
    const url = validateImageSource(source);
    const response = await fetch(url, { redirect: "error", signal });
    if (!response.ok) throw new Error("图片下载失败 HTTP " + response.status);
    // Same 35 MiB object limit as /storage/objects; enforce while streaming, not after buffering.
    const parts: Buffer[] = [];
    let bytes = 0;
    if (!response.body) throw new Error("图片响应为空");
    for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 35 * 1024 * 1024) throw new Error("图片超过现有媒体存储的 35 MiB 限制");
        parts.push(Buffer.from(chunk));
    }
    const data = Buffer.concat(parts);
    // Validate raster signatures, not a remote server's untrusted MIME declaration.
    const mimeType = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
        : data[0] === 255 && data[1] === 216 && data[2] === 255 ? "image/jpeg"
        : ["GIF87a", "GIF89a"].includes(data.subarray(0,6).toString()) ? "image/gif"
        : data.subarray(0,4).toString() === "RIFF" && data.subarray(8,12).toString() === "WEBP" ? "image/webp" : "";
    if (!mimeType) throw new Error("下载内容不是支持的 PNG/JPEG/WebP/GIF 图片");
    const storageKey = "image:" + crypto.createHash("sha256").update(data).digest("hex");
    await storage.putObject(storageKey, data, mimeType);
    return { storageKey, bytes: data.length, mimeType };
}
