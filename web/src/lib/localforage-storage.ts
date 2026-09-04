import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { deleteRemoteState, readRemoteState, writeRemoteState } from "@/services/remote-storage";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        let local: string | null = null;
        try {
            local = (await localforage.getItem<string>(name)) || null;
        } catch {
            local = window.localStorage.getItem(name);
        }
        try {
            const remote = await readRemoteState(name);
            if (!remote.enabled) return local;
            if (remote.value !== null) {
                if (remote.value !== local) await localforage.setItem(name, remote.value).catch(() => window.localStorage.setItem(name, remote.value!));
                return remote.value;
            }
            if (local) await writeRemoteState(name, local);
        } catch (error) {
            console.warn("Remote state read failed; using local cache", error);
        }
        return local;
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
        } catch {
            window.localStorage.setItem(name, value);
        }
        await writeRemoteState(name, value).catch((error) => console.warn("Remote state write failed", error));
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
        await deleteRemoteState(name).catch((error) => console.warn("Remote state delete failed", error));
    },
};
