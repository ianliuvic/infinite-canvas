import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const imageApi = readFileSync(new URL("./image.ts", import.meta.url), "utf8");
const project = readFileSync(new URL("../../pages/canvas/project.tsx", import.meta.url), "utf8");
const helpers = readFileSync(new URL("../../lib/canvas/canvas-generation-helpers.ts", import.meta.url), "utf8");
const crun = readFileSync(new URL("../../../../canvas-agent/src/server/crun.ts", import.meta.url), "utf8");

test("Crun image submission returns a durable task instead of waiting in the request script", () => {
    const imageScript = crun.match(/image: `([\s\S]*?)`,\n    video:/)?.[1] || "";
    assert.match(imageScript, /http\.post\("\/tasks"/);
    assert.match(imageScript, /onTask\(task\.task_id\)/);
    assert.match(imageScript, /return task/);
    assert.doesNotMatch(imageScript, /poll\(/);
});

test("image API polls a returned task and does not submit it again", () => {
    assert.match(imageApi, /pluginImageTaskId\(result\)/);
    assert.match(imageApi, /waitForPluginImageTask\(requestConfig, taskId, options\)/);
    assert.match(imageApi, /\[408, 429, 500, 502, 503, 504\]/);
});

test("server-managed Crun bypasses stale persisted call scripts", () => {
    assert.match(imageApi, /if \(isManagedCrunImageRequest\(requestConfig\)\)/);
    assert.match(imageApi, /requestManagedCrunImageTask\(requestConfig/);
    assert.match(imageApi, /buildApiUrl\(config\.baseUrl, "\/tasks"\)/);
    assert.match(imageApi, /options\?\.onTask\?\.\(taskId\)/);
});

test("canvas persists task IDs and resumes unfinished image nodes after restore", () => {
    assert.match(project, /imageTaskId: taskId/);
    assert.match(project, /\{ \.\.\.item, taskId \}/);
    assert.match(project, /filter\(hasResumableImageTask\).*pollImageNodeTask/);
    assert.match(helpers, /image\.taskId && !image\.content/);
});

test("worker status reads the durable job and never recreates a charged task", () => {
    assert.match(crun, /storage\.getGenerationJob\(normalizedJobId\)/);
    assert.match(crun, /CreateTask is deliberately called exactly once/);
    assert.doesNotMatch(crun.match(/export async function readCrunCanvasJob[\s\S]*?\n}\n\nasync function runCrunCanvasJob/)?.[0] || "", /createCrunTask\(/);
});
