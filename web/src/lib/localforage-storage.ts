import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { CANVAS_AGENT_MANAGED } from "@/constant/runtime-config";
import { readRemoteState, writeRemoteState } from "@/services/remote-storage";
import { mergeState } from "./state-merge";

localforage.config({ name: "infinite-canvas", storeName: "app_state" });
const outbox = localforage.createInstance({ name: "infinite-canvas", storeName: "state_outbox" });
type Pending = { id: string; name: string; writer: string; base: string | null; value: string; createdAt: number };
const writer = crypto.randomUUID();
const views = new Map<string, string | null>();
const localWrites = new Map<string, Promise<void>>();
const syncing = new Map<string, Promise<void>>();
const errors = new Map<string, string>();
const failedLocal = new Map<string, Pending>();
const dirty = new Set<string>();
const listeners = new Set<() => void>();
let status = "正在读取保存状态…";
let writing = 0;
let sequence = 0;

function notify() {
    status = failedLocal.size ? "本机保存失败，请勿刷新；请重试或导出待同步备份" : errors.size ? [...errors.values()][0] : dirty.size || writing ? "正在保存 · 请勿关闭页面" : CANVAS_AGENT_MANAGED ? "已保存到云端" : "已保存到本机";
    listeners.forEach((listener) => listener());
}
export const subscribeSaveStatus = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};
export const getSaveStatus = () => status;

async function pendingFor(name?: string) {
    const entries: Pending[] = [];
    await outbox.iterate<Pending, void>((item) => {
        if (!name || item.name === name) entries.push(item);
    });
    return entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function batches(entries: Pending[]) {
    const grouped = new Map<string, { item: Pending; ids: string[] }>();
    for (const entry of entries) {
        const key = entry.name + ":" + entry.writer;
        const batch = grouped.get(key);
        if (batch) {
            batch.item = { ...batch.item, value: entry.value };
            batch.ids.push(entry.id);
        } else grouped.set(key, { item: entry, ids: [entry.id] });
    }
    return [...grouped.values()];
}

async function sync(name: string) {
    const running = syncing.get(name);
    if (running) return running;
    const execute = async () => {
        let entries = await pendingFor(name);
        while (entries.length) {
            for (const { item, ids } of batches(entries)) {
                if ([...failedLocal.values()].some((failed) => failed.name === name)) throw new Error("本机写入失败，暂停云端同步以保护完整修改顺序");
                const remote = await readRemoteState(name);
                if (!remote.enabled) throw new Error("云端存储未启用；待同步内容仍保留在本机");
                const merged = mergeState(item.base, item.value, remote.value);
                if (merged !== remote.value) await writeRemoteState(name, merged);
                // Remove only the immutable record whose exact contents were acknowledged.
                for (const id of ids) await outbox.removeItem(id);
            }
            entries = await pendingFor(name);
        }
        errors.delete(name);
        if (!(await pendingFor(name)).length) dirty.delete(name);
    };
    const task = (async () => {
        try {
            if (navigator.locks) await navigator.locks.request("canvas-save:" + name, execute);
            else await execute(); // Server CAS still prevents stale writes across clients.
        } catch (error) {
            errors.set(name, "未同步：" + (error instanceof Error ? error.message : String(error)) + "（本机待同步记录保留）");
            throw error;
        } finally {
            syncing.delete(name);
            notify();
        }
    })();
    syncing.set(name, task);
    return task;
}

export async function flushDurableState(names?: string[]) {
    await Promise.all([...localWrites.entries()].filter(([name]) => !names || names.includes(name)).map(([, task]) => task.catch(() => undefined)));
    for (const item of failedLocal.values()) {
        if (names && !names.includes(item.name)) continue;
        if (CANVAS_AGENT_MANAGED) await outbox.setItem(item.id, item);
        await localforage.setItem(item.name, views.get(item.name) ?? item.value);
        failedLocal.delete(item.id);
    }
    const pending = await pendingFor();
    for (const name of new Set(pending.filter((item) => !names || names.includes(item.name)).map((item) => item.name))) {
        dirty.add(name);
        await sync(name);
        if ((await pendingFor(name)).length) throw new Error("仍有新的待同步内容，请等待保存完成");
    }
    notify();
}

export async function exportPendingState() {
    const pending = [...(await pendingFor()), ...failedLocal.values()];
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "canvas-pending-backup-v1", pending }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "canvas-pending-backup.json";
    link.click();
    URL.revokeObjectURL(url);
}

export async function discardConflictingState() {
    const names = [...errors.entries()].filter(([, error]) => error.includes("保存冲突")).map(([name]) => name);
    if (!names.length) return false;
    await Promise.all([...localWrites.entries()].filter(([name]) => names.includes(name)).map(([, task]) => task.catch(() => undefined)));
    const remoteValues = new Map<string, string | null>();
    for (const name of names) {
        const remote = await readRemoteState(name);
        if (!remote.enabled) throw new Error("云端存储未启用，无法安全清除本机冲突");
        remoteValues.set(name, remote.value);
    }
    const pending = await pendingFor();
    for (const item of pending) if (names.includes(item.name)) await outbox.removeItem(item.id);
    for (const [id, item] of failedLocal) if (names.includes(item.name)) failedLocal.delete(id);
    for (const [name, value] of remoteValues) {
        views.set(name, value);
        if (value === null) await localforage.removeItem(name);
        else await localforage.setItem(name, value);
        errors.delete(name);
        dirty.delete(name);
    }
    notify();
    return true;
}

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        const local = await localforage.getItem<string>(name);
        if (!CANVAS_AGENT_MANAGED) {
            views.set(name, local);
            notify();
            return local;
        }
        const hydrate = async () => {
            const pending = await pendingFor(name);
            if (pending.length) dirty.add(name);
            let value = pending.at(-1)?.value ?? local;
            try {
                const remote = await readRemoteState(name);
                if (remote.enabled) {
                    value = remote.value;
                    for (const { item } of batches(pending)) value = mergeState(item.base, item.value, value);
                    if (value === null) value = local;
                    if (remote.value === null && local !== null && !pending.length) {
                        const item: Pending = { id: crypto.randomUUID(), name, writer, base: null, value: local, createdAt: Date.now() };
                        await outbox.setItem(item.id, item);
                        pending.push(item);
                        dirty.add(name);
                    }
                }
                errors.delete(name);
            } catch (error) {
                value = pending.at(-1)?.value ?? local;
                errors.set(name, "读取/合并失败，正在使用本机副本：" + (error instanceof Error ? error.message : String(error)));
            }
            views.set(name, value);
            if (value !== null) await localforage.setItem(name, value);
            notify();
            if (pending.length) void sync(name).catch(() => undefined);
            return value;
        };
        return navigator.locks ? navigator.locks.request("canvas-save:" + name, hydrate) : hydrate();
    },
    setItem: (name, value) => {
        if (typeof window === "undefined") return Promise.resolve();
        const base = views.get(name);
        if (base === value) return localWrites.get(name)?.catch(() => undefined) || Promise.resolve();
        views.set(name, value);
        writing++;
        dirty.add(name);
        notify();
        // Ordered within this page even when several edits happen in the same millisecond.
        const item: Pending = { id: String(++sequence).padStart(12, "0") + "-" + crypto.randomUUID(), name, writer, base: base ?? null, value, createdAt: Date.now() };
        const task = (localWrites.get(name) || Promise.resolve())
            .catch(() => undefined)
            .then(async () => {
                if (CANVAS_AGENT_MANAGED) await outbox.setItem(item.id, item);
                await localforage.setItem(name, value);
                if (!CANVAS_AGENT_MANAGED) dirty.delete(name);
            })
            .catch((error) => {
                failedLocal.set(item.id, item);
                errors.set(name, "本机保存失败，请勿刷新：" + (error instanceof Error ? error.message : String(error)));
                throw error;
            })
            .finally(() => {
                writing--;
                notify();
            });
        localWrites.set(name, task);
        void task
            .then(async () => {
                if (CANVAS_AGENT_MANAGED) {
                    await sync(name);
                    if ((await pendingFor(name)).length) await sync(name);
                }
            })
            .catch(() => undefined);
        // Zustand ignores async persistence; UI and flush surface errors without unhandled rejections.
        return task.catch(() => undefined);
    },
    removeItem: async (name) => {
        if (!CANVAS_AGENT_MANAGED) { await localforage.removeItem(name); views.delete(name); return; }
        throw new Error("为保护历史数据，不支持直接清空持久化存储；请在界面删除指定画布或资产。");
    },
};

if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
        void flushDurableState().catch(() => undefined);
    });
    window.addEventListener("focus", () => {
        void flushDurableState().catch(() => undefined);
    });
    window.addEventListener("beforeunload", (event) => {
        if (writing || dirty.size || errors.size || failedLocal.size) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
}
