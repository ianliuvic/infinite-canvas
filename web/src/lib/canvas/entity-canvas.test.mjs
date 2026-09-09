import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(path, dependencies) {
    const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const context = vm.createContext({ exports: {}, require: name => {
        if (!(name in dependencies)) throw Error(name);
        return dependencies[name];
    } });
    vm.runInContext(source, context);
    return context.exports;
}
function setup(resolveImageUrl, resolveMediaUrl = async () => "blob:current-video") {
    const media = load("../../services/asset-media.ts", {
        "@/services/image-storage": { resolveImageUrl },
        "@/services/file-storage": { resolveMediaUrl },
    });
    let n=0;
    const placement = load("./entity-canvas.ts", {
        nanoid: { nanoid: () => String(++n) },
        "@/lib/canvas/canvas-node-size": { fitNodeSize: () => ({width:260,height:220}) },
        "@/lib/canvas/canvas-node-factory": {
            imageMetadata: image => ({content:image.url,storageKey:image.storageKey}),
            videoMetadata: video => ({content:video.url,storageKey:video.storageKey}),
        },
        "@/types/canvas": {CanvasNodeType:{Group:"group",Text:"text",Image:"image",Video:"video"}},
        "@/services/asset-media": media,
    });
    return {...media,...placement};
}
const asset = {id:"a",kind:"image",title:"scene",data:{dataUrl:"blob:expired-page",storageKey:"image:a",width:100,height:200}};
const entity = {id:"e",name:"scene",kind:"scene",aliases:[],tags:[],members:[{assetId:"a",role:"primary"}]};
const snapshot = {viewport:{x:0,y:0,k:1},viewportSize:{width:1200,height:720}};

test("entity placement restores current-session URL and preserves storage key", async () => {
    const calls=[];
    const api=setup(async key => {calls.push(key);return "blob:current-page";});
    const result=await api.buildEntityCanvasPlacement(entity,[asset],snapshot);
    const image=result.ops.find(op=>op.nodeType==="image");
    assert.equal(image.metadata.content,"blob:current-page");
    assert.equal(image.metadata.storageKey,"image:a");
    assert.deepEqual(calls,["image:a"]);
    assert.equal(asset.data.dataUrl,"blob:expired-page"); // Do not mutate shared library.
});
test("placement waits for reference media and only fetches selected members", async () => {
    let finish;
    const calls=[];
    const api=setup(key => {calls.push(key);return new Promise(resolve=>{finish=resolve;});});
    let completed=false;
    const task=api.buildEntityCanvasPlacement({...entity,members:[...entity.members,{assetId:"b",role:"detail"}]},[asset,{...asset,id:"b",data:{...asset.data,storageKey:"image:b"}}],snapshot,{assetIds:["a"]}).then(result=>{completed=true;return result;});
    await Promise.resolve();
    assert.equal(completed,false);
    finish("blob:ready");
    await task;
    assert.deepEqual(calls,["image:a"]);
});
test("missing durable image rejects instead of inserting expired fallback or partial group", async () => {
    const api=setup(async()=> "");
    await assert.rejects(api.buildEntityCanvasPlacement(entity,[asset],snapshot),/暂时无法读取/);
    await assert.rejects(api.resolveAssetMediaUrl("image","image:a","https://old.example/image"),/暂时无法读取/);
});
test("single image and video use the same durable resolution rule", async () => {
    const api=setup(async()=> "blob:current-image");
    assert.equal(await api.resolveAssetMediaUrl("image","image:a","blob:expired"),"blob:current-image");
    assert.equal(await api.resolveAssetMediaUrl("video","video:a","blob:expired"),"blob:current-video");
    assert.equal(await api.resolveAssetMediaUrl("image",undefined,"data:image/png;base64,test"),"data:image/png;base64,test");
});
