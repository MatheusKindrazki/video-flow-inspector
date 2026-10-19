import {test} from 'node:test';import assert from 'node:assert/strict';
import {VertexExpressClient} from '../../dist/analysis/vertex.js';
import {GeminiProvider} from '../../dist/analysis/gemini.js';
import {loadConfig} from '../../dist/utils/config.js';
test('Vertex Express uses documented global endpoint and header authentication, preserving multimodal body and abort signal',async()=>{
 let url,options;const c=new AbortController();
 const client=new VertexExpressClient('fixture-secret',async(u,o)=>{url=u;options=o;return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'hidden',thought:true},{text:'{"summary":"ok"}'}]}}],usageMetadata:{promptTokenCount:12,candidatesTokenCount:8}}),{status:200});});
 const r=await client.getGenerativeModel({model:'gemini-3.1-flash-lite',systemInstruction:'Inspect only',generationConfig:{maxOutputTokens:128}}).generateContent({contents:[{role:'user',parts:[{inlineData:{mimeType:'audio/mpeg',data:'fixture'}},{inlineData:{mimeType:'image/jpeg',data:'fixture'}}]}]},{signal:c.signal});
 assert.equal(url,'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.1-flash-lite:generateContent');assert.ok(!url.includes('fixture-secret'));assert.equal(options.headers['x-goog-api-key'],'fixture-secret');assert.equal(options.signal,c.signal);
 const body=JSON.parse(options.body);assert.equal(body.systemInstruction.parts[0].text,'Inspect only');assert.equal(body.contents[0].parts.length,2);assert.equal(r.response.text(),'{"summary":"ok"}');assert.equal(r.response.usageMetadata.promptTokenCount,12);
});
test('Vertex errors expose status for retries but never provider body/credentials',async()=>{
 const client=new VertexExpressClient('fixture-secret',async()=>new Response('credentials fixture-secret private project',{status:403}));
 await assert.rejects(client.getGenerativeModel({model:'gemini-3.5-flash'}).generateContent({contents:[]}),e=>e.status===403&&!e.message.includes('fixture-secret')&&!e.message.includes('private project'));
});
test('Vertex rejects unsafe model identifiers and pre-aborted calls without network work',async()=>{
 let calls=0;const client=new VertexExpressClient('fixture',async()=>{calls++;throw Error('must not call');});
 assert.throws(()=>client.getGenerativeModel({model:'../leak?key=x'}));const c=new AbortController();c.abort();await assert.rejects(client.getGenerativeModel({model:'gemini-3.5-flash'}).generateContent({contents:[]},{signal:c.signal}));assert.equal(calls,0);
});
test('configuration selects Vertex key only when backend explicitly requests Vertex',()=>{
 const old={...process.env};try{process.env.GEMINI_BACKEND='vertex';process.env.VERTEX_API_KEY='vertex-fixture';process.env.GEMINI_API_KEY='developer-fixture';const c=loadConfig();assert.equal(c.gemini.backend,'vertex');assert.equal(c.providers.gemini.apiKey,'vertex-fixture');process.env.GEMINI_BACKEND='gemini';assert.equal(loadConfig().providers.gemini.apiKey,'developer-fixture');}finally{process.env=old;}
});
