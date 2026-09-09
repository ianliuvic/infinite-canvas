import test from "node:test";
import assert from "node:assert/strict";
import { mergeState } from "./state-merge.ts";
const state = (nodes) => JSON.stringify({ state: { projects: [{ id: "p", nodes }] } });
const nodes = (value) => JSON.parse(value).state.projects[0].nodes;

test("independent node additions survive stale tab saves", () => {
    assert.deepEqual(nodes(mergeState(state([]), state([{ id: "a" }]), state([{ id: "b" }]))).map(n => n.id).sort(), ["a", "b"]);
});
test("independent fields on same node merge", () => {
    const base = state([{ id: "a", title: "old", x: 0 }]);
    assert.deepEqual(nodes(mergeState(base, state([{ id: "a", title: "new", x: 0 }]), state([{ id: "a", title: "old", x: 5 }]))), [{ id: "a", title: "new", x: 5 }]);
});
test("same field divergent edit fails without overwriting", () => {
    assert.throws(() => mergeState(state([{ id: "a", title: "old" }]), state([{ id: "a", title: "ours" }]), state([{ id: "a", title: "theirs" }])), /保存冲突/);
});
test("delete unchanged node without resurrecting, preserve unrelated addition", () => {
    assert.deepEqual(nodes(mergeState(state([{ id: "a" }]), state([]), state([{ id: "a" }, { id: "b" }]))), [{ id: "b" }]);
});
test("delete versus edit is a conflict, not data loss", () => {
    assert.throws(() => mergeState(state([{ id: "a", x: 1 }]), state([]), state([{ id: "a", x: 2 }])), /保存冲突/);
});
test("replaying acknowledged write is idempotent", () => {
    const value = state([{ id: "a" }]);
    assert.equal(mergeState(state([]), value, value), value);
});
test("blob URL renewal does not conflict with stable media", () => {
    const b = [{ id: "a", url: "blob:old", storageKey: "image:a", x: 0 }];
    assert.equal(nodes(mergeState(state(b), state([{ ...b[0], url: "blob:local" }]), state([{ ...b[0], url: "blob:remote", x: 4 }])))[0].x, 4);
});
