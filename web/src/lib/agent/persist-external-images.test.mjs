import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import ts from "typescript";
const source=ts.transpileModule(readFileSync(new URL("./persist-external-images.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup(importer=async()=>({storageKey:"image:saved",bytes:123,mimeType:"image/webp"})){
    const c=vm.createContext({exports:{},require:name=>{
        if(name.includes("remote-storage"))return{importRemoteImage:importer};
        if(name.includes("asset-media"))return{resolveAssetMediaUrl:async(_kind,key)=>"blob:"+key};
        throw Error(name);
    }});
    vm.runInContext(source,c);
    return c.exports.persistExternalImages;
}
const snapshot=()=>({projectId:"p",nodes:[{id:"n",type:"image",position:{x:4,y:5},metadata:{content:"https://wearhongxiu.com/a.webp",groupId:"g"}}],connections:[{id:"c"}]});
test("updates only original media metadata; no asset creation or added nodes",async()=>{
    const state=snapshot();let ops;
    const result=await setup()([{nodeId:"n"}],()=>state,value=>{ops=value;});
    assert.equal(ops.length,1);assert.equal(ops[0].type,"update_node");assert.equal(ops[0].id,"n");
    assert.equal(ops[0].metadata.storageKey,"image:saved");
    assert.equal(ops[0].patch,undefined);assert.equal(result.addedAssets,0);assert.equal(result.addedNodes,0);
});
test("existing stored image does not download again",async()=>{
    const state=snapshot();state.nodes[0].metadata.storageKey="image:existing";
    await setup(async()=>{throw Error("unexpected download");})([{nodeId:"n"}],()=>state,()=>{});
});
test("missing source and changed canvas never patch nodes",async()=>{
    let state=snapshot();state.nodes[0].metadata.content="blob:expired";
    await assert.rejects(setup()([{nodeId:"n"}],()=>state,()=>{throw Error("unexpected");}),/原始 HTTPS/);
    state=snapshot();
    await assert.rejects(setup(async()=>{state={...state,projectId:"other"};return{storageKey:"image:x"};})([{nodeId:"n"}],()=>state,()=>{throw Error("unexpected");}),/画布或图片已改变/);
});
