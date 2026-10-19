import { z } from 'zod';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { handleAnalyzeVideoFlow } from './tools/analyze-video-flow.js';
import { AnalyzeVideoFlowInputFields, AnalyzeVideoFlowInputSchema, type AnalyzeVideoFlowInput } from './schemas/input.js';
import { analyzeVideoFlow, type PipelineOutput } from './orchestrator/pipeline.js';
import { AnalysisJobManager } from './jobs/manager.js';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';
const json = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
/** Lossless fragments bound response size even for a single unusually large item. */
export function boundedReportResponse(value:unknown,fragmentOffset=0){
 const serialized=JSON.stringify(value);
 if(Buffer.byteLength(serialized)<=48000&&fragmentOffset===0)return json(value);
 const length=4000;return json({format:'json_fragment',fragment_offset:fragmentOffset,fragment:serialized.slice(fragmentOffset,fragmentOffset+length),next_fragment_offset:fragmentOffset+length<serialized.length?fragmentOffset+length:null,total_characters:serialized.length});
}
/** Both the synchronous compatibility tool and background tools share one bounded queue. */
export function createServer(options: {
  execute?: typeof analyzeVideoFlow;
  jobsDirectory?: string;
} = {}): McpServer {
  const config = loadConfig();
  const server = new McpServer({ name: 'video-flow-inspector', version: '0.2.0' });
  let manager: AnalysisJobManager<AnalyzeVideoFlowInput, PipelineOutput> | undefined;
  const jobs = () => manager ??= new AnalysisJobManager({ directory: options.jobsDirectory ?? process.env.ANALYSIS_JOBS_DIR ?? join(homedir(), '.video-flow-inspector', 'jobs'), execute: (input, runOptions) => (options.execute ?? analyzeVideoFlow)(input, runOptions), maxConcurrent: 1, maxQueued: 4 });
  const guarded = (fn: () => Promise<ReturnType<typeof json>>) => fn().catch(() => ({ ...json({ error: 'Request failed. Check job ID, queue capacity, directory ownership and server configuration. Internal paths and provider errors are not exposed.' }), isError: true }));
  server.tool('analyze_video_flow', 'Analyze a UI recording up to 10 minutes with synchronized audio, bugs and usability findings. Compatibility blocking tool; prefer start_video_analysis for long recordings.', AnalyzeVideoFlowInputFields, async (args, extra) => handleAnalyzeVideoFlow(args, async (input) => {
    const m = jobs();
    const job = await m.start(input);
    try {
      while (true) {
        extra.signal.throwIfAborted();
        const state = await m.result(job.id);
        if (state.job.status === 'completed' && state.result)
          return state.result;
        if (['failed', 'cancelled', 'interrupted'].includes(state.job.status))
          throw new Error('Analysis did not complete. Inspect its job status.');
        await delay(100, undefined, { signal: extra.signal });
      }
    }
    catch (error) {
      await m.cancel(job.id);
      throw error;
    }
  }));
  server.tool('start_video_analysis', 'Start a persisted background recording analysis; returns a job ID immediately. This may send sampled screen images and audio to the configured provider.', AnalyzeVideoFlowInputFields, async (args) => guarded(async () => {
    const parsed = AnalyzeVideoFlowInputSchema.safeParse(args);
    if (!parsed.success)
      return { ...json({ error: 'Invalid analysis input', fields: parsed.error.issues.map(i => i.path.join('.')) }), isError: true };
    return json(await jobs().start(parsed.data));
  }));
  const id = { job_id: z.string().uuid() };
  server.tool('get_video_analysis', 'Get job status and current processing progress.', id, async (args) => guarded(async () => json(await jobs().get(args.job_id))));
  server.tool('cancel_video_analysis', 'Cancel a queued or running job. In-flight requests are aborted; cancellation cannot undo provider costs already incurred.', id, async (args) => guarded(async () => json(await jobs().cancel(args.job_id))));
  server.tool('get_video_analysis_result', 'Read a completed report. Defaults to a compact summary; retrieve findings, speech, timeline, segment summaries or frame evidence in pages.', { ...id, section: z.enum(['summary', 'findings', 'transcript', 'timeline', 'segments', 'frames']).default('summary'), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(25), fragment_offset:z.number().int().nonnegative().default(0) }, async (args) => guarded(async () => {
    const saved = await jobs().result(args.job_id);
    if (!saved.result)
      return json(saved.job);
    const r = saved.result;
    if (args.section === 'summary')
      return boundedReportResponse({ job: saved.job, summary: r.summary, findings_count: r.findings.length, quality: r.quality, metadata: { ...r.metadata, provider_runs: undefined }, next_best_action: r.next_best_action, source_sha256: r.evidence_catalog.source_sha256, sections: ['findings', 'transcript', 'timeline', 'segments', 'frames'] },args.fragment_offset);
    const sections = { findings: r.findings, transcript: r.transcript, timeline: r.timeline, segments: r.segment_summaries, frames: r.evidence_catalog.frames };
    const list = sections[args.section];
    return boundedReportResponse({ job_id: args.job_id, section: args.section, total: list.length, offset: args.offset, items: list.slice(args.offset, args.offset + args.limit), next_offset: args.offset + args.limit < list.length ? args.offset + args.limit : null },args.fragment_offset);
  }));
  const originalClose = server.close.bind(server);
  server.close = async () => { if (manager)
    await manager.close(); await originalClose(); };
  const previous = server.server.onclose;
  server.server.onclose = () => { previous?.(); if (manager)
    void manager.close().catch(() => logger.warn('Analysis queue shutdown failed')); };
  logger.info('MCP configured', { max_duration_seconds: config.maxVideoDurationSeconds, segment_concurrency: config.session.concurrency, audio_provider: 'gemini', async_jobs: true });
  return server;
}
