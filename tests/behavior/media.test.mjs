import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {checkFfmpegAvailable,extractVideoMetadata} from '../../dist/preprocessing/metadata.js';
import {extractKeyframes,computeKeyframeChangeScores} from '../../dist/preprocessing/keyframe-extractor.js';
import {extractAudioSegment} from '../../dist/preprocessing/audio.js';
const exec=promisify(execFile);const available=await checkFfmpegAvailable();
test('real FFmpeg: generated 10-minute audiovisual fixture preserves segment PTS and pixel signatures',{skip:!available?'ffmpeg/ffprobe unavailable; no real-media validation on this host':false},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'vfi-media-'));
 try{
  const video=join(dir,'ten-minutes.mp4');
  await exec('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=2','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','600','-c:v','mpeg4','-q:v','10','-c:a','aac','-b:a','32k',video],{timeout:120000});
  const metadata=await extractVideoMetadata(video);assert.equal(metadata.duration_ms,600000);assert.equal(metadata.has_audio,true);
  const framesDir=join(dir,'frames');await mkdir(framesDir);const frames=await extractKeyframes(video,60000,{intervalSeconds:.5,maxFrames:160,outputDir:framesDir,startMs:58000});
  assert.ok(frames.length>=110);assert.equal(frames[0].timestamp_ms,58000);assert.ok(frames.at(-1).timestamp_ms<118000);assert.ok(frames.at(-1).timestamp_ms>=117000);assert.equal(frames[0].pixel_signature.length,1024);
  const scores=await computeKeyframeChangeScores(frames);assert.ok(scores.some(v=>v>0));
  const audio=await extractAudioSegment(video,{id:'S2',start_ms:58000,end_ms:118000},join(dir,'speech.mp3'));assert.equal(audio.start_ms,58000);assert.ok(audio.base64.length>1000);
  const probe=await exec('ffprobe',['-v','quiet','-show_entries','format=duration','-of','json',join(dir,'speech.mp3')]);assert.ok(Math.abs(Number(JSON.parse(probe.stdout).format.duration)-60)<.3);
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(extractAudioSegment(video,{id:'S1',start_ms:0,end_ms:60000},join(dir,'cancelled.mp3'),cancelled.signal));
 }finally{await rm(dir,{recursive:true,force:true});}
});
