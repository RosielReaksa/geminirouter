import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gr-dubbing-jobs-'));
process.env.DUBBING_DB_PATH = path.join(tempHome, 'jobs.db');
process.env.DUBBING_OUTPUT_DIR = path.join(tempHome, 'output');

const {
  buildSrt,
  buildVtt,
  createDubbingJob,
  deleteDubbingJob,
  getDubbingJob,
  listDubbingJobs,
} = await import('../src/dubbingJob.js');

function sampleJob() {
  return createDubbingJob({
    mediaUrl: 'https://example.com/input.mp4',
    targetLanguage: 'km',
    sourceLanguage: 'zh',
    model: 'gemini-3.5-flash-lite',
    chunkSeconds: 300,
    concurrency: 4,
    responseFormat: 'json',
    mediaType: 'video',
  });
}

test('dubbing jobs are created, listed, read and deleted', () => {
  const job = sampleJob();
  assert.equal(job.status, 'queued');
  assert.equal(job.progress, 0);
  assert.match(job.id, /^dj-/);

  const fetched = getDubbingJob(job.id);
  assert.equal(fetched?.id, job.id);
  assert.equal(listDubbingJobs(10).some((entry) => entry.id === job.id), true);

  assert.equal(deleteDubbingJob(job.id), true);
  assert.equal(getDubbingJob(job.id), null);
  assert.equal(deleteDubbingJob(job.id), false);
});

test('SRT and VTT include numeric timings and stable segment order', () => {
  const segments = [
    {
      start: '00:00.0',
      end: '00:02.5',
      speaker_gender: 'female' as const,
      vocal_timbre: 'bright',
      character_role: 'sister',
      original_transcript: '你好',
      khmer_dubbing: 'sister_line',
      startSeconds: 0,
      endSeconds: 2.5,
    },
    {
      start: '00:03.0',
      end: '00:05.0',
      speaker_gender: 'male' as const,
      vocal_timbre: 'deep',
      character_role: 'brother',
      original_transcript: '再见',
      khmer_dubbing: 'brother_line',
      startSeconds: 3,
      endSeconds: 5,
    },
  ];

  const srt = buildSrt(segments);
  assert.match(srt, /00:00:00,000 --> 00:00:02,500/);
  assert.match(srt, /00:00:03,000 --> 00:00:05,000/);
  assert.match(srt, /sister_line/);

  const vtt = buildVtt(segments);
  assert.match(vtt, /WEBVTT/);
  assert.match(vtt, /00:00:00.000 --> 00:00:02.500/);
  assert.match(vtt, /brother_line/);
});
