import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectKeyframes } from '../../dist/preprocessing/frame-selector.js';
test('ten-minute equal-change recording retains balanced temporal coverage', () => {
  const frames = Array.from({length: 40}, (_, index) => ({index, timestamp_ms: Math.round(index * 600000/39), changeScore: 0}));
  const r = selectKeyframes(frames, {maxFrames:20,changeThreshold:0.15,safetyIntervalMs:3000,minFrames:2});
  assert.equal(r.selected.length,20);
  assert.equal(r.selected[0].index,0);
  assert.equal(r.selected.at(-1).index,39);
  assert.ok(Math.max(...r.selected.slice(1).map((f,i)=> f.timestamp_ms-r.selected[i].timestamp_ms)) <= 62000);
});
test('temporal coverage does not discard a representative high-change event', () => {
 const frames=Array.from({length:40},(_,index)=>({index,timestamp_ms:index*1000,changeScore:index===29?1:0}));
 const r=selectKeyframes(frames,{maxFrames:8,changeThreshold:.5,safetyIntervalMs:3000,minFrames:2});
 assert.ok(r.selected.some(f=>f.index===29));
});
test('early clustered changes cannot consume all later temporal coverage',()=>{
 const frames=Array.from({length:120},(_,index)=>({index,timestamp_ms:index*5000,changeScore:index<40?.9:0}));
 const r=selectKeyframes(frames,{maxFrames:20,changeThreshold:.15,safetyIntervalMs:3000,minFrames:2});
 assert.ok(Math.max(...r.selected.slice(1).map((f,i)=>f.timestamp_ms-r.selected[i].timestamp_ms))<=90000);
});
