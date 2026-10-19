import {test} from 'node:test';
import assert from 'node:assert/strict';
import {planSegments, mapConcurrent} from '../../dist/orchestrator/segments.js';
import {validateSegmentEvidence, mergeFindings} from '../../dist/analysis/evidence.js';
test('600 seconds are fully covered by bounded overlapping segments',()=>{
 const s=planSegments(600000,60000,2000);
 assert.equal(s[0].start_ms,0);assert.equal(s.at(-1).end_ms,600000);assert.equal(s.length,11);
 for(let i=1;i<s.length;i++){assert.equal(s[i-1].end_ms-s[i].start_ms,2000);assert.ok(s[i].end_ms-s[i].start_ms<=60000);}
 assert.throws(()=>planSegments(0,60000,2000));assert.throws(()=>planSegments(100,100,100));
});
test('segment concurrency is bounded and results retain source order',async()=>{
 let active=0,max=0;
 const r=await mapConcurrent([3,2,1],2,async n=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,n));active--;return n;});
 assert.deepEqual(r,[3,2,1]);assert.equal(max,2);
});
const context={segment:{id:'S1',start_ms:58000,end_ms:118000},keyframes:[{index:7,timestamp_ms:60000}],hasAudio:true};
const transcript={id:'T1',start_ms:60000,end_ms:62000,text:'Não achei como continuar'};
const finding={id:'F1',category:'usability',basis:'reported',severity:'minor',title:'Next step unclear',description:'Participant reports difficulty',timestamp_ms:61000,evidence_refs:[{kind:'transcript',transcript_id:'T1'}],recommendation:'Clarify next step'};
test('evidence admits timestamped speech but rejects invented references and out-of-range timestamps',()=>{
 const r=validateSegmentEvidence({transcript:[transcript],findings:[finding,{...finding,id:'F2',evidence_refs:[{kind:'frame',frame_index:999}]},{...finding,id:'F3',timestamp_ms:999999}]},context);
 assert.equal(r.findings.length,1);assert.equal(r.transcript[0].start_ms,60000);assert.equal(r.warnings.length,2);
});
test('a silent source cannot produce speech evidence',()=>{
 const r=validateSegmentEvidence({transcript:[transcript],findings:[finding]},{...context,hasAudio:false});
 assert.equal(r.transcript.length,0);assert.equal(r.findings.length,0);assert.ok(r.warnings.length>=1);
});
test('only overlapping duplicates merge; repeated failures later remain separate',()=>{
 const a={...finding,source_segment:'S1'};const b={...finding,id:'F2',timestamp_ms:62000,source_segment:'S2'};const c={...finding,id:'F3',timestamp_ms:300000,source_segment:'S5'};
 assert.equal(mergeFindings([a,b,c]).length,2);
});
test('duplicate raw transcript/finding IDs are rejected before prefixing',()=>{
 const r=validateSegmentEvidence({transcript:[transcript,transcript],findings:[finding,finding]},context);
 assert.equal(r.transcript.length,1);assert.equal(r.findings.length,1);assert.ok(r.warnings.length>=2);
});
test('participant speech alone cannot establish an observed screen defect',()=>{
 const r=validateSegmentEvidence({transcript:[transcript],findings:[{...finding,basis:'observed'}]},context);assert.equal(r.findings.length,0);
});
test('overlap dedup preserves higher severity and never merges distinct same-segment events',()=>{
 const a={...finding,source_segment:'S1',source_start_ms:58000,source_end_ms:118000};
 const critical={...a,id:'F2',source_segment:'R1',source_start_ms:60000,source_end_ms:65000,severity:'critical',timestamp_ms:62000};
 const r=mergeFindings([a,critical]);assert.equal(r.length,1);assert.equal(r[0].severity,'critical');
 assert.equal(mergeFindings([a,{...a,id:'another',timestamp_ms:62000}]).length,2);
});
test('an overlap merge cannot absorb a second distinct event from the same contributing segment',()=>{
 const a={...finding,source_segment:'S1',source_start_ms:58000,source_end_ms:118000};
 const b={...a,id:'B',source_segment:'S2',timestamp_ms:62000};const c={...b,id:'C',timestamp_ms:63000};
 assert.equal(mergeFindings([a,b,c]).length,2);
});
