import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {createServer} from '../../dist/server.js';
const read=r=>JSON.parse(r.content[0].text);
test('MCP exposes blocking compatibility plus persisted paginated background jobs',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vfi-mcp-'));const previous=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='fixture-not-live';
 const fixture={summary:'fixture report',findings:[{id:'F1'},{id:'F2'}],transcript:[],timeline:[],segment_summaries:[],evidence_catalog:{source_sha256:'a'.repeat(64),frames:[]},quality:{complete:true,warnings:[]},metadata:{provider:'fixture',analysis_duration_ms:1},next_best_action:{action:'Verify'},detected_issues:[],confidence:0};
 let executed=0;const server=createServer({jobsDirectory:dir,execute:async()=>{executed++;return fixture;}});const client=new Client({name:'behavior-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();
 try{
  await server.connect(a);await client.connect(b);const tools=await client.listTools();assert.equal(tools.tools.length,5);
  const invalid=await client.callTool({name:'start_video_analysis',arguments:{goal:'Inspect recording'}});assert.equal(invalid.isError,true);assert.equal(executed,0);
  const start=read(await client.callTool({name:'start_video_analysis',arguments:{goal:'Inspect recording',video_file_path:'/fixture.mp4'}}));assert.ok(start.id);
  let state;for(let i=0;i<100;i++){state=read(await client.callTool({name:'get_video_analysis',arguments:{job_id:start.id}}));if(state.status==='completed')break;await new Promise(r=>setTimeout(r,1));}assert.equal(state.status,'completed');
  const summary=read(await client.callTool({name:'get_video_analysis_result',arguments:{job_id:start.id}}));assert.equal(summary.summary,'fixture report');assert.equal(summary.findings_count,2);assert.equal(summary.transcript,undefined);
  const page=read(await client.callTool({name:'get_video_analysis_result',arguments:{job_id:start.id,section:'findings',limit:1}}));assert.equal(page.items.length,1);assert.equal(page.next_offset,1);
  const compatibility=read(await client.callTool({name:'analyze_video_flow',arguments:{goal:'Inspect recording',video_file_path:'/fixture.mp4'}}));assert.equal(compatibility.summary,'fixture report');assert.equal(executed,2);
 }finally{await client.close();await server.close();await rm(dir,{recursive:true,force:true});if(previous===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=previous;}
});
test('oversized individual report items are retrievable as lossless byte-bounded fragments',async()=>{
 const {boundedReportResponse}=await import('../../dist/server.js');
 const value={items:[{text:'長い説明'.repeat(30000)}]};let offset=0;let text='';
 while(true){const response=boundedReportResponse(value,offset);assert.ok(Buffer.byteLength(response.content[0].text)<=48000);const page=read(response);assert.equal(page.format,'json_fragment');text+=page.fragment;if(page.next_fragment_offset===null)break;offset=page.next_fragment_offset;}
 assert.deepEqual(JSON.parse(text),value);
});
