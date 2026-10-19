import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {analyzeVideoFlow} from '../../dist/orchestrator/pipeline.js';
import {loadConfig} from '../../dist/utils/config.js';
import {GeminiProvider} from '../../dist/analysis/gemini.js';
async function fixture(run){
 const folder=await mkdtemp(join(tmpdir(),'vfi-fixture-'));const source=join(folder,'fixture.mp4');await writeFile(source,'NOT REAL VIDEO: orchestration fixture');
 const old=process.env.GEMINI_API_KEY;process.env.GEMINI_API_KEY='fixture-never-sent';const config=loadConfig();config.session.maxRefinements=0;config.session.concurrency=2;
 const deps={config:()=>config,checkMedia:async()=>true,source:async()=>({filePath:source,sizeBytes:10,wasDownloaded:false}),metadata:async()=>({duration_ms:600000,width:800,height:600,fps:30,codec:'fixture',size_bytes:10,format:'mp4',has_audio:true}),frames:async(_file,duration,opts)=>{const p=join(opts.outputDir,'fixture.jpg');await writeFile(p,'NOT REAL JPEG');return[{index:0,timestamp_ms:opts.startMs+1000,path:p,width:800,height:600,pixel_signature:[0]}];},audio:async(_file,s)=>({mimeType:'audio/mpeg',base64:'FIXTURE',start_ms:s.start_ms,end_ms:s.end_ms})};
 try{await run(deps,config);}finally{if(old===undefined)delete process.env.GEMINI_API_KEY;else process.env.GEMINI_API_KEY=old;await rm(folder,{recursive:true,force:true});}
}
function provider(context){const frame=context.keyframes[0];context.reserveCall?.();return {providerName:'gemini',model:'fixture',result:{raw:'{}',summary:'Fixture segment',timeline:[{timestamp_ms:frame.timestamp_ms,frame_index:frame.index,action:'navigate',description:'Visible transition',status:'normal'}],detected_issues:[],hypotheses:[],recommended_actions:[],transcript:context.audio?[{id:'T1',start_ms:frame.timestamp_ms,end_ms:frame.timestamp_ms+1000,text:'Onde continuo?'}]:[],findings:[{id:'F1',category:'usability',basis:context.audio?'reported':'observed',severity:'minor',title:'Next step unclear',description:'Participant statement',timestamp_ms:frame.timestamp_ms,evidence_refs:context.audio?[{kind:'transcript',transcript_id:'T1'}]:[{kind:'frame',frame_index:frame.index}],recommendation:'Verify next-step label'}],usage:{input_tokens:100,output_tokens:30}}};}
test('full 600-second orchestration keeps absolute clocks, audio and unique evidence IDs',async()=>fixture(async deps=>{
 let calls=0;const r=await analyzeVideoFlow({goal:'Inspect usability'}, {},{...deps,analyze:async c=>{calls++;return provider(c);}});
 assert.equal(calls,11);assert.equal(r.metadata.segments,11);assert.equal(r.findings.length,11);assert.equal(r.transcript[1].start_ms,59000);assert.equal(r.metadata.audio.analyzed_segments,11);assert.equal(r.evidence_catalog.source_sha256.length,64);assert.equal(new Set(r.evidence_catalog.frames.map(f=>f.index)).size,11);
}));
test('absent audio is explicit, required mode rejects and ignore mode never extracts',async()=>fixture(async deps=>{
 let audioCalls=0;const d={...deps,audio:async()=>{audioCalls++;throw Error('must not call');},analyze:async c=>provider(c)};
 const absent={...d,metadata:async()=>({...await deps.metadata(),has_audio:false})};
 const r=await analyzeVideoFlow({goal:'Inspect flow'}, {},absent);assert.equal(r.transcript.length,0);assert.equal(audioCalls,0);assert.equal(r.metadata.audio.source_has_audio,false);
 await assert.rejects(analyzeVideoFlow({goal:'Inspect flow',audio_mode:'required'},{},absent),e=>e.code==='AUDIO_REQUIRED');
 const ignored=await analyzeVideoFlow({goal:'Inspect flow',audio_mode:'ignore'}, {},d);assert.equal(audioCalls,0);assert.equal(ignored.segment_summaries[0].audio_status,'ignored');
}));
test('one failed segment is reported as partial, never as no problems',async()=>fixture(async deps=>{
 const r=await analyzeVideoFlow({goal:'Inspect flow'},{},{...deps,analyze:async c=>{if(c.segment.id==='S2')throw Error('fixture failure with secret');return provider(c);}});
 assert.equal(r.quality.complete,false);assert.equal(r.segment_summaries[1].status,'failed');assert.ok(r.quality.warnings.some(w=>w.startsWith('S2:')));assert.ok(!JSON.stringify(r).includes('secret'));
}));
test('cancel before work prevents all provider calls',async()=>fixture(async deps=>{
 const c=new AbortController();c.abort();let calls=0;
 await assert.rejects(analyzeVideoFlow({goal:'Inspect flow'},{signal:c.signal},{...deps,analyze:async x=>{calls++;return provider(x);}}));assert.equal(calls,0);
}));
test('Gemini receives audio alongside frames with absolute segment mapping',async()=>{
 let request;const client={getGenerativeModel:()=>({generateContent:async r=>{request=r;return {response:{text:()=>JSON.stringify({summary:'fixture',findings:[],transcript:[],timeline:[],detected_issues:[],hypotheses:[],recommended_actions:[]})}};}})};
 await new GeminiProvider('fixture','fixture',1,1000,{client}).analyze({goal:'Inspect flow',keyframes:[],video_duration_ms:600000,segment:{id:'S2',start_ms:58000,end_ms:118000},audio:{mimeType:'audio/mpeg',base64:'fixture-audio',start_ms:58000,end_ms:118000}});
 assert.equal(request.contents[0].parts.at(-1).inlineData.mimeType,'audio/mpeg');assert.match(request.contents[0].parts[0].text,/58000ms/);
});
test('shared call budget bounds all segments and declares incomplete intervals',async()=>fixture(async(deps,config)=>{
 config.session.maxProviderCalls=3;const r=await analyzeVideoFlow({goal:'Inspect flow'},{},{...deps,analyze:async c=>provider(c)});
 assert.equal(r.metadata.provider_calls,3);assert.equal(r.quality.complete,false);assert.ok(r.quality.warnings.some(w=>w.includes('budget exhausted')));
}));
test('focused refinement keeps every transcript cited by merged findings',async()=>fixture(async(deps,config)=>{
 config.session.maxRefinements=1;
 const r=await analyzeVideoFlow({goal:'Inspect flow'},{},{...deps,analyze:async c=>{const out=provider(c);if(c.segment.id==='S1'||c.segment.id==='R1')out.result.findings[0].severity='critical';return out;}});
 assert.equal(r.metadata.refinements,1);assert.ok(r.findings.some(f=>f.merged_sources?.includes('R1')));
 const ids=new Set(r.transcript.map(t=>t.id));for(const f of r.findings)for(const ref of f.evidence_refs)if(ref.kind==='transcript')assert.ok(ids.has(ref.transcript_id));
}));
test('missing structured findings cannot hide legacy issues behind a clean result',async()=>fixture(async deps=>{
 const r=await analyzeVideoFlow({goal:'Inspect flow'},{},{...deps,analyze:async c=>{const out=provider(c);out.result.findings=[];out.result.detected_issues=[{id:'I',severity:'major',type:'unknown',title:'legacy',description:'legacy',actual_behavior:'legacy',evidence:'free text only'}];return out;}});
 assert.equal(r.findings.length,0);assert.equal(r.quality.complete,false);assert.ok(r.quality.warnings.some(w=>w.includes('legacy issues')));
}));
