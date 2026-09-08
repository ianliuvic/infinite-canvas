import test from "node:test";
import assert from "node:assert/strict";
import { validateImageSource, importExternalImage } from "./import-image.ts";

test("allowlisted HTTPS only; reject credentials, alternate hosts, local URLs and ports", () => {
    assert.equal(validateImageSource("https://wearhongxiu.com/a.webp").hostname,"wearhongxiu.com");
    for (const url of ["http://wearhongxiu.com/a","https://127.0.0.1/a","https://wearhongxiu.com.evil.test/a","https://x:pass@wearhongxiu.com/a","https://wearhongxiu.com:8000/a","file:///etc/passwd"]) assert.throws(()=>validateImageSource(url));
});
test("download persists bytes, validates raster signature, and deduplicates by content", async () => {
    const original=globalThis.fetch;
    const puts=[];
    globalThis.fetch=async (_url,options)=>{
        assert.equal(options.redirect,"error");
        assert.equal(options.headers,undefined);
        return new Response(Buffer.from("RIFF0000WEBPtest"),{status:200});
    };
    try {
        const storage={putObject:async(...args)=>{puts.push(args);}};
        const a=await importExternalImage("https://wearhongxiu.com/a.webp",storage);
        const b=await importExternalImage("https://wearhongxiu.com/b.webp",storage);
        assert.equal(a.storageKey,b.storageKey);
        assert.equal(a.mimeType,"image/webp");
        assert.equal(puts.length,2);
        assert.equal(puts[0][1].toString(),"RIFF0000WEBPtest");
    } finally {globalThis.fetch=original;}
});
test("HTML and upstream failure never enter media storage", async () => {
    const original=globalThis.fetch;
    let writes=0;
    const storage={putObject:async()=>{writes++;}};
    try {
        globalThis.fetch=async()=>new Response("<html>login</html>",{headers:{"content-type":"image/png"}});
        await assert.rejects(importExternalImage("https://wearhongxiu.com/a",storage),/不是支持/);
        globalThis.fetch=async()=>new Response("no",{status:403});
        await assert.rejects(importExternalImage("https://wearhongxiu.com/a",storage),/403/);
        assert.equal(writes,0);
    } finally {globalThis.fetch=original;}
});
