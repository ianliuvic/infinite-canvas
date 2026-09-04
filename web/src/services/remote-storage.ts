import { CANVAS_AGENT_MANAGED, CANVAS_AGENT_URL } from "@/constant/runtime-config";

type RemoteState = { enabled: boolean; value: string | null };
const stateQueues = new Map<string, Promise<void>>();

export async function readRemoteState(key: string): Promise<RemoteState> {
    const connection = storageConnection();
    if (!connection) return { enabled: false, value: null };
    const response = await fetch(storageUrl(connection.endpoint, "state", key), { credentials: "include", headers: authHeaders(connection.token) });
    if (response.status === 404) return { enabled: true, value: null };
    if (!response.ok) throw await responseError(response);
    const result = (await response.json()) as { value?: unknown };
    return { enabled: true, value: typeof result.value === "string" ? result.value : null };
}

export function writeRemoteState(key: string, value: string) {
    const connection = storageConnection();
    if (!connection) return Promise.resolve();
    const previous = stateQueues.get(key) || Promise.resolve();
    const current = previous
        .catch(() => undefined)
        .then(async () => {
            const response = await fetch(storageUrl(connection.endpoint, "state", key), {
                method: "PUT",
                credentials: "include",
                headers: { ...authHeaders(connection.token), "content-type": "application/json" },
                body: JSON.stringify({ value }),
            });
            if (!response.ok) throw await responseError(response);
        });
    stateQueues.set(key, current);
    const cleanup = () => {
        if (stateQueues.get(key) === current) stateQueues.delete(key);
    };
    void current.then(cleanup, cleanup);
    return current;
}

export async function deleteRemoteState(key: string) {
    const connection = storageConnection();
    if (!connection) return;
    const response = await fetch(storageUrl(connection.endpoint, "state", key), { method: "DELETE", credentials: "include", headers: authHeaders(connection.token) });
    if (!response.ok && response.status !== 404) throw await responseError(response);
}

export async function writeRemoteObject(key: string, blob: Blob) {
    const connection = storageConnection();
    if (!connection) return false;
    const response = await fetch(storageUrl(connection.endpoint, "objects", key), {
        method: "PUT",
        credentials: "include",
        headers: { ...authHeaders(connection.token), "content-type": "application/octet-stream", "x-canvas-content-type": blob.type || "application/octet-stream" },
        body: blob,
    });
    if (!response.ok) throw await responseError(response);
    return true;
}

export async function readRemoteObject(key: string) {
    const connection = storageConnection();
    if (!connection) return null;
    const response = await fetch(storageUrl(connection.endpoint, "objects", key), { credentials: "include", headers: authHeaders(connection.token) });
    if (response.status === 404) return null;
    if (!response.ok) throw await responseError(response);
    return await response.blob();
}

export async function deleteRemoteObjects(keys: Iterable<string>) {
    const connection = storageConnection();
    if (!connection) return;
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const response = await fetch(storageUrl(connection.endpoint, "objects", key), { method: "DELETE", credentials: "include", headers: authHeaders(connection.token) });
            if (!response.ok && response.status !== 404) throw await responseError(response);
        }),
    );
}

function storageConnection() {
    if (typeof window === "undefined" || !CANVAS_AGENT_MANAGED) return null;
    return { endpoint: CANVAS_AGENT_URL.replace(/\/$/, ""), token: sessionStorage.getItem("canvas-agent-token") || "managed" };
}

function storageUrl(endpoint: string, kind: "state" | "objects", key: string) {
    return `${endpoint}/storage/${kind}/${encodeURIComponent(key)}`;
}

function authHeaders(token: string) {
    return { "x-canvas-agent-token": token };
}

async function responseError(response: Response) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return new Error(typeof body?.error === "string" ? body.error : `Remote storage request failed (${response.status})`);
}
