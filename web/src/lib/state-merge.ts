// Apply only changes relative to the caller's own view. Never silently discard conflicts.
export function mergeState(base: string | null, local: string, remote: string | null): string {
    if (local === remote || base === remote) return local;
    if (base === local) return remote ?? local;
    return JSON.stringify(merge(JSON.parse(base ?? "{}"), JSON.parse(local), JSON.parse(remote ?? "{}"), "state"));
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const identified = (value: unknown): value is { id: string }[] => Array.isArray(value) && value.every((item) => object(item) && typeof item.id === "string") && new Set(value.map((item) => item.id)).size === value.length;

function merge(base: unknown, local: unknown, remote: unknown, path: string): unknown {
    if (equal(local, remote) || equal(base, remote)) return local;
    if (equal(base, local)) return remote;
    // Bookkeeping and viewport preferences, not user content.
    if (path.endsWith(".updatedAt") && typeof local === "string" && typeof remote === "string") return local > remote ? local : remote;
    if (path.endsWith(".viewport") || path.endsWith(".activeChatId")) return local;
    // Hydration recreates blob URLs in each browser. The storageKey is the durable identity.
    if (typeof local === "string" && typeof remote === "string" && local.startsWith("blob:") && remote.startsWith("blob:")) return local;
    if (identified(local) && identified(remote) && (base === undefined || identified(base))) {
        const before = new Map(((base as { id: string }[] | undefined) || []).map((item) => [item.id, item]));
        const ours = new Map(local.map((item) => [item.id, item]));
        const theirs = new Map(remote.map((item) => [item.id, item]));
        return [...new Set([...ours.keys(), ...theirs.keys()])].map((id) => merge(before.get(id), ours.get(id), theirs.get(id), path + "[" + id + "]")).filter((item) => item !== undefined);
    }
    if (object(local) && object(remote) && (base === undefined || object(base))) {
        return Object.fromEntries([...new Set([...Object.keys(local), ...Object.keys(remote)])].map((key) => [key, merge(object(base) ? base[key] : undefined, local[key], remote[key], path + "." + key)]).filter(([, value]) => value !== undefined));
    }
    throw new Error("保存冲突：" + path + " 在另一个页面也被修改。两份内容均已保留，未覆盖云端；请导出待同步备份后处理冲突。");
}
