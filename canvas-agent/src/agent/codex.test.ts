import assert from "node:assert/strict";
import test from "node:test";

import { interruptCodexTurn, runCodexTurn } from "./codex.js";

test("正式 turn 创建前也可以停止任务", async () => {
    let finished = 0;
    const running = runCodexTurn("分析视频", () => undefined, [], {
        threadId: "thread-before-turn",
        onFinish: () => { finished += 1; },
    });

    assert.equal(await interruptCodexTurn("thread-before-turn"), true);
    await running;
    assert.equal(finished, 1);
});
