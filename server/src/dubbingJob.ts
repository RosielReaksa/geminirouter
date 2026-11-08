/**
 * Async finished-video dubbing jobs.
 *
 * The synchronous /v1/audio/dubbing endpoint returns the model's timed script.
 * This module takes the next step: it downloads the source media, generates the
 * script, synthesizes per-speaker TTS, fits each line to its original timing,
 * mixes music/SFX stems, muxes the finished video, and writes SRT/VTT.
 *
 * Jobs are persisted in SQLite so a bridge restart does not lose them.
 */
import axios from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { tts } from 'edge-tts';
import {
  MediaError,
  dubChunks,
  probeAudio,
  readMediaConfig,
  splitAudio,
  type AudioChunk,
  type DubbingChunkResult,
  type DubbingOptions,
  type DubbingSegmentInternal,
  type MediaConfig,
  type MediaRouteDeps,
} from './mediaTranscription.js';

export type DubbingJobStatus = 'queued' | 'processing' | 'mixing' | 'completed' | 'failed';

export interface DubbingJob {
  id: string;
  status: DubbingJobStatus;
  progress: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  mediaUrl: string;
  musicUrl?: string;
  sfxUrl?: string;
  glossary?: string;
  speakers?: string;
  webhookUrl?: string;
  targetLanguage: string;
  sourceLanguage: string;
  model: string;
  chunkSeconds: number;
  concurrency: number;
  responseFormat: 'json' | 'array';
  mediaType: 'audio' | 'video';
  durationSeconds?: number;
  outputPath?: string;
  srtPath?: string;
  vttPath?: string;
  segments?: string;
}

interface JobRow {
  id: string;
  status: string;
  progress: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  media_url: string;
  music_url: string | null;
  sfx_url: string | null;
  glossary: string | null;
  speakers: string | null;
  webhook_url: string | null;
  target_language: string;
  source_language: string;
  model: string;
  chunk_seconds: number;
  concurrency: number;
  response_format: string;
  media_type: string;
  duration_seconds: number | null;
  output_path: string | null;
  srt_path: string | null;
  vtt_path: string | null;
  segments: string | null;
}

const DB_PATH =
  process.env.DUBBING_DB_PATH || path.resolve(process.cwd(), '.data', 'dubbing-jobs.db');
const OUTPUT_ROOT =
  process.env.DUBBING_OUTPUT_DIR || path.resolve(process.cwd(), '.data', 'dubbing-jobs');

let _db: DatabaseSync | null = null;
let _workerTimer: NodeJS.Timeout | null = null;

function db(): DatabaseSync {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      error TEXT,
      media_url TEXT NOT NULL,
      music_url TEXT,
      sfx_url TEXT,
      glossary TEXT,
      speakers TEXT,
      webhook_url TEXT,
      target_language TEXT NOT NULL,
      source_language TEXT NOT NULL,
      model TEXT NOT NULL,
      chunk_seconds INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      response_format TEXT NOT NULL,
      media_type TEXT NOT NULL,
      duration_seconds REAL,
      output_path TEXT,
      srt_path TEXT,
      vtt_path TEXT,
      segments TEXT
    );
  `);
  // Crash recovery: a job left mid-flight is re-queued on startup.
  database
    .prepare(`UPDATE jobs SET status = 'queued', progress = 0 WHERE status IN ('processing', 'mixing')`)
    .run();
  _db = database;
  return database;
}

function rowToJob(row: JobRow): DubbingJob {
  return {
    id: row.id,
    status: row.status as DubbingJobStatus,
    progress: row.progress,
    createdAt: row.created_at,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    error: row.error || undefined,
    mediaUrl: row.media_url,
    musicUrl: row.music_url || undefined,
    sfxUrl: row.sfx_url || undefined,
    glossary: row.glossary || undefined,
    speakers: row.speakers || undefined,
    webhookUrl: row.webhook_url || undefined,
    targetLanguage: row.target_language,
    sourceLanguage: row.source_language,
    model: row.model,
    chunkSeconds: row.chunk_seconds,
    concurrency: row.concurrency,
    responseFormat: row.response_format as 'json' | 'array',
    mediaType: row.media_type as 'audio' | 'video',
    durationSeconds: row.duration_seconds || undefined,
    outputPath: row.output_path || undefined,
    srtPath: row.srt_path || undefined,
    vttPath: row.vtt_path || undefined,
    segments: row.segments || undefined,
  };
}

export function createDubbingJob(
  input: Omit<DubbingJob, 'id' | 'status' | 'progress' | 'createdAt'>,
): DubbingJob {
  const id = `dj-${crypto.randomUUID()}`;
  const job: DubbingJob = {
    ...input,
    id,
    status: 'queued',
    progress: 0,
    createdAt: new Date().toISOString(),
  };
  db()
    .prepare(
      `INSERT INTO jobs (
        id, status, progress, created_at, media_url, music_url, sfx_url, glossary,
        speakers, webhook_url, target_language, source_language, model, chunk_seconds,
        concurrency, response_format, media_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      job.id,
      job.status,
      job.progress,
      job.createdAt,
      job.mediaUrl,
      job.musicUrl ?? null,
      job.sfxUrl ?? null,
      job.glossary ?? null,
      job.speakers ?? null,
      job.webhookUrl ?? null,
      job.targetLanguage,
      job.sourceLanguage,
      job.model,
      job.chunkSeconds,
      job.concurrency,
      job.responseFormat,
      job.mediaType,
    );
  return job;
}

export function getDubbingJob(id: string): DubbingJob | null {
  const row = db().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listDubbingJobs(limit = 50): DubbingJob[] {
  const rows = db()
    .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as JobRow[];
  return rows.map(rowToJob);
}

export function deleteDubbingJob(id: string): boolean {
  const job = getDubbingJob(id);
  if (!job) return false;
  db().prepare('DELETE FROM jobs WHERE id = ?').run(id);
  const dir = path.join(OUTPUT_ROOT, id);
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

function updateJob(
  id: string,
  fields: Partial<Pick<DubbingJob, 'status' | 'progress' | 'error' | 'startedAt' | 'completedAt' | 'durationSeconds' | 'outputPath' | 'srtPath' | 'vttPath' | 'segments' | 'mediaType'>>,
): void {
  db()
    .prepare(
      `UPDATE jobs SET
        status = COALESCE(?, status),
        progress = COALESCE(?, progress),
        error = COALESCE(?, error),
        started_at = COALESCE(?, started_at),
        completed_at = COALESCE(?, completed_at),
        duration_seconds = COALESCE(?, duration_seconds),
        output_path = COALESCE(?, output_path),
        srt_path = COALESCE(?, srt_path),
        vtt_path = COALESCE(?, vtt_path),
        segments = COALESCE(?, segments),
        media_type = COALESCE(?, media_type)
      WHERE id = ?`,
    )
    .run(
      fields.status ?? null,
      fields.progress ?? null,
      fields.error ?? null,
      fields.startedAt ?? null,
      fields.completedAt ?? null,
      fields.durationSeconds ?? null,
      fields.outputPath ?? null,
      fields.srtPath ?? null,
      fields.vttPath ?? null,
      fields.segments ?? null,
      fields.mediaType ?? null,
      id,
    );
}

function claimNextJob(): DubbingJob | null {
  const row = db()
    .prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
    .get() as JobRow | undefined;
  if (!row) return null;
  updateJob(row.id, { status: 'processing', progress: 1, startedAt: new Date().toISOString() });
  return getDubbingJob(row.id) ?? null;
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

function runProcess(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    const onClose = (code: number | null) => {
      if (code === 0) resolve(stdout);
      else reject(new MediaError(500, 'ffmpeg_error', stderr || `${command} failed`));
    };
    child.on('error', (error) => reject(new MediaError(500, 'ffmpeg_error', error.message)));
    child.on('close', onClose);
    if (signal) {
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    }
  });
}

async function downloadTo(url: string, dest: string, maxBytes: number, signal: AbortSignal): Promise<void> {
  const response = await axios.get(url, { responseType: 'stream', timeout: 120_000, signal });
  const writer = fs.createWriteStream(dest);
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    response.data.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        writer.destroy();
        reject(new MediaError(413, 'media_too_large', `Download exceeds ${maxBytes} bytes.`));
      }
    });
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    writer.on('close', () => {
      if (size > maxBytes) {
        fs.rmSync(dest, { force: true });
      }
    });
  });
}

async function extractAudio(videoPath: string, dest: string, signal: AbortSignal): Promise<void> {
  await runProcess(
    'ffmpeg',
    ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '128k', dest],
    signal,
  );
}

async function probeDuration(filePath: string): Promise<number> {
  const output = await runProcess(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
  );
  return Number.parseFloat(output.trim());
}

async function silenceFileAsync(dest: string, seconds: number, signal: AbortSignal): Promise<void> {
  await runProcess(
    'ffmpeg',
    [
      '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=24000`,
      '-t', seconds.toFixed(3), '-c:a', 'libmp3lame', '-b:a', '128k', dest,
    ],
    signal,
  );
}

async function fitTtsDuration(
  input: string,
  dest: string,
  targetSeconds: number,
  signal: AbortSignal,
): Promise<void> {
  const duration = await probeDuration(input);
  if (!Number.isFinite(duration) || duration <= 0) {
    fs.copyFileSync(input, dest);
    return;
  }
  const ratio = duration / targetSeconds;
  const clamped = Math.min(2, Math.max(0.5, ratio));
  const filters: string[] = [];
  let remaining = clamped;
  while (remaining > 2) {
    filters.push('atempo=2');
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5');
    remaining /= 0.5;
  }
  filters.push(`atempo=${remaining.toFixed(4)}`);
  await runProcess(
    'ffmpeg',
    ['-y', '-i', input, '-filter:a', filters.join(','), '-t', targetSeconds.toFixed(3), '-c:a', 'libmp3lame', '-b:a', '128k', dest],
    signal,
  );
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

const DEFAULT_VOICES: Record<string, { female: string; male: string }> = {
  km: { female: 'km-KH-SreymomNeural', male: 'km-KH-PisethNeural' },
  en: { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' },
  zh: { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' },
  th: { female: 'th-TH-PremwadeeNeural', male: 'th-TH-NiwatNeural' },
  vi: { female: 'vi-VN-HaiMyNeural', male: 'vi-VN-NamMinhNeural' },
  es: { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
  fr: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
  de: { female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' },
  ja: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
  ko: { female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' },
};

function voiceForSegment(
  segment: DubbingSegmentInternal,
  targetLanguage: string,
  speakers?: Record<string, string>,
): string {
  const role = (segment.character_role || '').trim();
  const mapped = role ? speakers?.[role] : undefined;
  if (mapped) return mapped;
  const lang = targetLanguage.toLowerCase().split('-')[0];
  const gender = segment.speaker_gender === 'male' ? 'male' : 'female';
  return DEFAULT_VOICES[lang]?.[gender] ?? DEFAULT_VOICES.en[gender];
}

function speakerId(segment: DubbingSegmentInternal): string {
  const role = (segment.character_role || '').trim();
  if (role) return role.toLowerCase().replace(/\s+/g, '_');
  return segment.speaker_gender === 'male' ? 'male_speaker' : 'female_speaker';
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number, comma: boolean): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const millis = Math.round((safe - Math.floor(safe)) * 1000);
  const sep = comma ? ',' : '.';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${sep}${String(millis).padStart(3, '0')}`;
}

export function buildSrt(segments: DubbingSegmentInternal[]): string {
  return segments
    .map((segment, index) => {
      const text = (segment.khmer_dubbing || segment.original_transcript || '').trim();
      return `${index + 1}\n${formatTimestamp(segment.startSeconds, true)} --> ${formatTimestamp(segment.endSeconds, true)}\n${text}`;
    })
    .join('\n\n');
}

export function buildVtt(segments: DubbingSegmentInternal[]): string {
  return `WEBVTT\n\n${segments
    .map((segment) => {
      const text = (segment.khmer_dubbing || segment.original_transcript || '').trim();
      return `${formatTimestamp(segment.startSeconds, false)} --> ${formatTimestamp(segment.endSeconds, false)}\n${text}`;
    })
    .join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Job processing
// ---------------------------------------------------------------------------

async function processJob(job: DubbingJob, deps: MediaRouteDeps, config: MediaConfig): Promise<void> {
  const jobDir = path.join(OUTPUT_ROOT, job.id);
  fs.mkdirSync(jobDir, { recursive: true });
  const controller = new AbortController();
  const signal = controller.signal;

  try {
    updateJob(job.id, { progress: 5 });

    // 1. Download source media.
    const mediaExt = job.mediaUrl.split('?')[0].split('.').pop()?.toLowerCase() || 'bin';
    const mediaPath = path.join(jobDir, `input.${mediaExt}`);
    await downloadTo(job.mediaUrl, mediaPath, config.maxUploadBytes, signal);
    const probe = await probeAudio(mediaPath, config, signal);
    const isVideo = (probe.formatName || '').includes('video') || /\.(mp4|mov|mkv|webm)$/i.test(mediaPath);
    updateJob(job.id, { progress: 15, durationSeconds: probe.durationSeconds, mediaType: isVideo ? 'video' : 'audio' });

    // 2. Extract audio for dubbing.
    const audioPath = path.join(jobDir, 'audio.mp3');
    if (isVideo) {
      await extractAudio(mediaPath, audioPath, signal);
    } else {
      fs.copyFileSync(mediaPath, audioPath);
    }

    // 3. Split into chunks and generate the timed script.
    const chunkSeconds = Math.min(job.chunkSeconds, 3600);
    const chunks: AudioChunk[] = await splitAudio(audioPath, jobDir, probe.durationSeconds, chunkSeconds, config, signal);
    updateJob(job.id, { progress: 30 });

    const prompt = job.glossary
      ? `Dub the audio into ${job.targetLanguage}. Follow the glossary exactly.\n\nGlossary:\n${job.glossary}`
      : undefined;
    const options: DubbingOptions = {
      model: job.model,
      prompt,
      sourceLanguage: job.sourceLanguage,
      targetLanguage: job.targetLanguage,
      chunkSeconds,
      maxTokens: 65_535,
      temperature: 0,
      concurrency: job.concurrency,
      concurrencyExplicit: true,
      responseFormat: 'json',
    };
    const results: DubbingChunkResult[] = await dubChunks(chunks, options, config, deps, signal, console as any);
    const segments = results
      .flatMap((result) => result.segments)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    updateJob(job.id, {
      progress: 55,
      segments: JSON.stringify(
        segments.map((segment) => ({
          ...segment,
          speaker_id: speakerId(segment),
          voice: voiceForSegment(segment, job.targetLanguage, job.speakers ? JSON.parse(job.speakers) : undefined),
        })),
      ),
    });

    // 4. TTS per segment and fit to the original timing.
    const speakers = job.speakers ? (JSON.parse(job.speakers) as Record<string, string>) : undefined;
    const segmentFiles: Array<{ file: string; start: number; end: number }> = [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const text = (segment.khmer_dubbing || segment.original_transcript || '').trim();
      if (!text) continue;
      const voice = voiceForSegment(segment, job.targetLanguage, speakers);
      const ttsPath = path.join(jobDir, `tts-${String(index).padStart(4, '0')}.mp3`);
      const fittedPath = path.join(jobDir, `seg-${String(index).padStart(4, '0')}.mp3`);
      const audio = await tts(text, { voice });
      fs.writeFileSync(ttsPath, audio);
      const duration = Math.max(0.2, segment.endSeconds - segment.startSeconds);
      await fitTtsDuration(ttsPath, fittedPath, duration, signal);
      segmentFiles.push({ file: fittedPath, start: segment.startSeconds, end: segment.endSeconds });
      updateJob(job.id, { progress: 55 + Math.round(((index + 1) / segments.length) * 25) });
    }

    // 5. Assemble the dubbed timeline with silence gaps.
    const concatList = path.join(jobDir, 'concat.txt');
    const concatLines: string[] = [];
    let previousEnd = 0;
    for (const segment of segmentFiles) {
      const gap = segment.start - previousEnd;
      if (gap > 0.05) {
        const silencePath = path.join(jobDir, `silence-${String(concatLines.length).padStart(4, '0')}.mp3`);
        await silenceFileAsync(silencePath, gap, signal);
        concatLines.push(`file '${silencePath}'`);
      }
      concatLines.push(`file '${segment.file}'`);
      previousEnd = Math.max(previousEnd, segment.end);
    }
    fs.writeFileSync(concatList, concatLines.join('\n'));
    const dubbedPath = path.join(jobDir, 'dubbed.mp3');
    await runProcess('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-c:a', 'libmp3lame', '-b:a', '128k', dubbedPath], signal);
    updateJob(job.id, { progress: 85 });

    // 6. Mix music/SFX stems.
    const mixedPath = path.join(jobDir, 'mixed.mp3');
    const musicPath = job.musicUrl ? path.join(jobDir, 'music.mp3') : null;
    const sfxPath = job.sfxUrl ? path.join(jobDir, 'sfx.mp3') : null;
    if (musicPath) await downloadTo(job.musicUrl!, musicPath, config.maxUploadBytes, signal);
    if (sfxPath) await downloadTo(job.sfxUrl!, sfxPath, config.maxUploadBytes, signal);
    if (musicPath || sfxPath) {
      const inputs = ['-i', dubbedPath];
      if (musicPath) inputs.push('-stream_loop', '-1', '-i', musicPath);
      if (sfxPath) inputs.push('-stream_loop', '-1', '-i', sfxPath);
      const filterParts: string[] = [];
      let inputIndex = 1;
      if (musicPath) {
        filterParts.push(`[${inputIndex}:a]volume=0.25[m]`);
        inputIndex += 1;
      }
      if (sfxPath) {
        filterParts.push(`[${inputIndex}:a]volume=0.6[s]`);
        inputIndex += 1;
      }
      const mixInputs = `[0:a]${musicPath ? '[m]' : ''}${sfxPath ? '[s]' : ''}`;
      filterParts.push(`${mixInputs}amix=inputs=${1 + (musicPath ? 1 : 0) + (sfxPath ? 1 : 0)}:duration=first[out]`);
      await runProcess(
        'ffmpeg',
        [...inputs, '-filter_complex', filterParts.join(';'), '-map', '[out]', '-t', probe.durationSeconds.toFixed(3), '-c:a', 'libmp3lame', '-b:a', '192k', mixedPath],
        signal,
      );
    } else {
      fs.copyFileSync(dubbedPath, mixedPath);
    }
    updateJob(job.id, { progress: 90 });

    // 7. Mux with video when the source was a video.
    const outputPath = path.join(jobDir, isVideo ? 'output.mp4' : 'output.mp3');
    if (isVideo) {
      await runProcess(
        'ffmpeg',
        ['-y', '-i', mediaPath, '-i', mixedPath, '-c:v', 'copy', '-map', '0:v:0', '-map', '1:a:0', '-shortest', outputPath],
        signal,
      );
    } else {
      fs.copyFileSync(mixedPath, outputPath);
    }

    // 8. Subtitles.
    const srtPath = path.join(jobDir, 'output.srt');
    const vttPath = path.join(jobDir, 'output.vtt');
    fs.writeFileSync(srtPath, buildSrt(segments));
    fs.writeFileSync(vttPath, buildVtt(segments));

    updateJob(job.id, {
      status: 'completed',
      progress: 100,
      completedAt: new Date().toISOString(),
      outputPath,
      srtPath,
      vttPath,
    });
  } catch (error: any) {
    updateJob(job.id, {
      status: 'failed',
      progress: 0,
      completedAt: new Date().toISOString(),
      error: error?.message || String(error),
    });
  } finally {
    if (job.webhookUrl) {
      const latest = getDubbingJob(job.id);
      if (latest) {
        try {
          await axios.post(
            job.webhookUrl,
            {
              job_id: latest.id,
              status: latest.status,
              progress: latest.progress,
              error: latest.error,
              output_path: latest.outputPath,
              srt_path: latest.srtPath,
              vtt_path: latest.vttPath,
            },
            { timeout: 15_000, validateStatus: () => true },
          );
        } catch {
          // Webhook delivery is best-effort.
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

export function startDubbingWorkers(deps: MediaRouteDeps, workerCount = 2): void {
  if (_workerTimer) return;
  const config = readMediaConfig();
  const workers = Math.max(1, workerCount);
  for (let index = 0; index < workers; index += 1) {
    void (async () => {
      while (true) {
        const job = claimNextJob();
        if (!job) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
        try {
          await processJob(job, deps, config);
        } catch {
          // processJob records the failure; keep the worker alive.
        }
      }
    })();
  }
  _workerTimer = setInterval(() => undefined, 1_000_000);
  _workerTimer.unref?.();
}

export function dubbingWorkerCount(): number {
  return Math.max(1, Number.parseInt(process.env.MEDIA_JOB_WORKERS || '2', 10) || 2);
}
