import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { mergeState } from "./state-merge.ts";

const source = ts.transpileModule(readFileSync(new URL("./localforage-storage.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const key = "infinite-canvas:canvas_store";
const value = (nodes) => JSON.stringify({ state: { projects: [{ id: "p", nodes }] } });
const ids = (v) => JSON.parse(v).state.projects[0].nodes.map(n => n.id).sort();
const tick = () => new Promise(resolve => setImmediate(resolve));

function environment() {
    const db = new Map();
    const locks = new Map();
    const env = { remote: value([]), revision: 1, offline: false, diskFailure: false, db };
    const instance = (name) => {
        if (!db.has(name)) db.set(name, new Map());
        const store = db.get(name);
        return {
            getItem: async k => structuredClone(store.get(k) ?? null),
            setItem: async (k, v) => { if (env.diskFailure) throw Error("quota"); store.set(k, structuredClone(v)); },
            removeItem: async k => { store.delete(k); },
            iterate: async fn => { for (const [k, v] of [...store]) fn(structuredClone(v), k); },
        };
    };
    env.tab = () => {
        let revision;
        const storage = { ...instance("app_state"), config() {}, createInstance: ({storeName}) => instance(storeName) };
        const remote = {
            readRemoteState: async () => { if (env.offline) throw Error("offline"); revision = env.revision; return { enabled: true, value: env.remote }; },
            writeRemoteState: async (_k, v) => { if (env.offline) throw Error("offline"); if (revision !== env.revision) throw Error("409"); env.remote = v; revision = ++env.revision; },
        };
        const context = vm.createContext({
            exports: {}, crypto, console, Blob, URL,
            window: { addEventListener() {} },
            navigator: { locks: { request: async (name, run) => {
                const task = (locks.get(name) || Promise.resolve()).catch(() => {}).then(run);
                locks.set(name, task);
                return task;
            } } },
            require: (name) => {
                if (name === "localforage") return { default: storage };
                if (name.includes("runtime-config")) return { CANVAS_AGENT_MANAGED: true };
                if (name.includes("remote-storage")) return remote;
                if (name === "./state-merge") return { mergeState };
                throw Error(name);
            },
        });
        vm.runInContext(source, context);
        return context.exports;
    };
    return env;
}

test("offline edit survives reload and is later committed, not overwritten by old remote", async () => {
    const e = environment(), a = e.tab();
    await a.localForageStorage.getItem(key);
    e.offline = true;
    await a.localForageStorage.setItem(key, value([{id:"generated"}]));
    await tick();
    const b = e.tab();
    assert.deepEqual(ids(await b.localForageStorage.getItem(key)), ["generated"]);
    e.offline = false;
    await tick();
    await b.flushDurableState();
    assert.deepEqual(ids(e.remote), ["generated"]);
    assert.equal(e.db.get("state_outbox").size, 0);
});
test("two stale tabs preserve independent additions and subsequent edits", async () => {
    const e = environment(), a = e.tab(), b = e.tab();
    await Promise.all([a.localForageStorage.getItem(key), b.localForageStorage.getItem(key)]);
    await Promise.all([a.localForageStorage.setItem(key, value([{id:"a"}])), b.localForageStorage.setItem(key, value([{id:"b"}]))]);
    await Promise.all([a.flushDurableState(), b.flushDurableState()]);
    assert.deepEqual(ids(e.remote), ["a", "b"]);
    await a.localForageStorage.setItem(key, value([{id:"a", title:"edited"}]));
    await a.flushDurableState();
    assert.deepEqual(ids(e.remote), ["a", "b"]);
});
test("divergent same-field conflict retains durable outbox across reload", async () => {
    const e = environment();
    e.remote = value([{id:"a", title:"old"}]);
    const a=e.tab(), b=e.tab();
    await Promise.all([a.localForageStorage.getItem(key), b.localForageStorage.getItem(key)]);
    await a.localForageStorage.setItem(key, value([{id:"a", title:"first"}]));
    await a.flushDurableState();
    await b.localForageStorage.setItem(key, value([{id:"a", title:"second"}]));
    await assert.rejects(b.flushDurableState(), /保存冲突/);
    assert.match(e.remote, /first/);
    assert.ok(e.db.get("state_outbox").size > 0);
    const c=e.tab();
    assert.match(await c.localForageStorage.getItem(key), /second/);
    assert.match(c.getSaveStatus(), /冲突/);
});
test("rapid offline edits are replayed as a complete latest snapshot", async () => {
    const e=environment(), a=e.tab();
    await a.localForageStorage.getItem(key);
    e.offline=true;
    const tasks=[];
    for(let i=1;i<=20;i++) tasks.push(a.localForageStorage.setItem(key, value(Array.from({length:i}, (_,n)=>({id:String(n)})))));
    await Promise.all(tasks);
    await tick();
    e.offline=false;
    const b=e.tab();
    assert.equal(ids(await b.localForageStorage.getItem(key)).length,20);
    await b.flushDurableState();
    assert.equal(ids(e.remote).length,20);
});
test("local quota failure blocks success and can be retried without losing earlier edits", async () => {
    const e=environment(), a=e.tab();
    await a.localForageStorage.getItem(key);
    e.diskFailure=true;
    await a.localForageStorage.setItem(key,value([{id:"a"}]));
    assert.match(a.getSaveStatus(), /本机保存失败/);
    await assert.rejects(a.flushDurableState(), /quota/);
    e.diskFailure=false;
    await a.localForageStorage.setItem(key,value([{id:"a"},{id:"b"}]));
    await tick();
    await a.flushDurableState();
    assert.deepEqual(ids(e.remote),["a","b"]);
});
