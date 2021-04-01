import { mutation, StatefulService, ViewHandler, Inject } from 'services/core';
import path from 'path';
import execa from 'execa';
import ndarray from 'ndarray';
import createBuffer from 'gl-buffer';
import transitions from 'gl-transitions';
import createTransition from 'gl-transition';
import createTexture from 'gl-texture2d';
import Vue from 'vue';
import fs from 'fs-extra';

import { StreamingService } from './streaming';
import electron from 'electron';
import Utils from './utils';

// const FFMPEG_DIR = path.resolve('../../', 'Downloads', 'ffmpeg', 'bin');
const FFMPEG_DIR = Utils.isDevMode()
  ? path.resolve('node_modules', 'ffmpeg-ffprobe-static')
  : path.resolve(process.resourcesPath, 'node_modules', 'ffmpeg-ffprobe-static');

const FFMPEG_EXE = path.join(FFMPEG_DIR, 'ffmpeg.exe');
const FFPROBE_EXE = path.join(FFMPEG_DIR, 'ffprobe.exe');

const CLIP_DIR = path.resolve('C:/', 'Users', 'acree', 'Videos');
export const CLIP_1 = path.join(CLIP_DIR, '1.mp4');
export const CLIP_2 = path.join(CLIP_DIR, '2.mp4');
export const CLIP_3 = path.join(CLIP_DIR, '3.mp4');
export const CLIP_4 = path.join(CLIP_DIR, 'Facebook Refactor.mov');
const EXPORT_NAME = path.join(CLIP_DIR, 'output');

const WIDTH = 1280;
const HEIGHT = 720;
const FPS = 30;

// Frames are RGBA, 4 bytes per pixel
const FRAME_BYTE_SIZE = WIDTH * HEIGHT * 4;

export const SCRUB_WIDTH = 320;
export const SCRUB_HEIGHT = 180;
export const SCRUB_FRAMES = 20;
export const SCRUB_SPRITE_DIRECTORY = path.join(
  electron.remote.app.getPath('userData'),
  'highlighter',
);

const TRANSITION_DURATION = 1;
const TRANSITION_FRAMES = TRANSITION_DURATION * FPS;

interface PmapOptions<TVal, TRet> {
  concurrency?: number;
  onProgress?: (completedItem: TVal, returnVal: TRet, nComplete: number) => void;
}

/**
 * Allows waiting on a bulk set of computationally expensive async
 * bulk operations. It behaves similarly to Promise.all, but
 * allows passing a concurency number, which restricts the number
 * of inflight operations at once, and also allows processing of
 * each item as it completes.
 * @param items A set of iterms to operate on
 * @param executor Takes an item and returns a rpmoise
 * @param options The max number of operations to process at once
 * @returns An array of return values in the same order as the original items
 */
export function pmap<TVal, TRet>(
  items: TVal[],
  executor: (val: TVal) => Promise<TRet>,
  options: PmapOptions<TVal, TRet> = {},
): Promise<TRet[]> {
  const opts: PmapOptions<TVal, TRet> = {
    concurrency: Infinity,
    ...options,
  };

  return new Promise<TRet[]>((resolve, reject) => {
    // Store each item with its index for ordering of
    // return values later.
    const toExecute: [TVal, number][] = items.map((item, index) => [item, index]);
    const returns: [TRet, number][] = [];
    const totalNum = toExecute.length;
    let errored = false;

    function executeNext() {
      const item = toExecute.shift();

      executor(item[0])
        .then(ret => {
          // Another promise rejected, so abort
          if (errored) return;

          returns.push([ret, item[1]]);

          // Update progress callback
          if (opts.onProgress) {
            options.onProgress(item[0], ret, returns.length);
          }

          if (toExecute.length > 0) {
            executeNext();
          } else if (returns.length === totalNum) {
            const orderedReturns: TRet[] = [];

            returns.forEach(set => {
              orderedReturns[set[1]] = set[0];
            });

            resolve(orderedReturns);
          }
        })
        .catch(e => {
          errored = true;
          reject(e);
        });
    }

    // Fire off the initial set of requests
    Array(Math.min(items.length, opts.concurrency))
      .fill(0)
      .forEach(() => executeNext());
  });
}

/**
 * Extracts an audio file from a video file
 */
export class AudioSource {
  readonly outPath: string;

  constructor(public readonly sourcePath: string) {
    const parsed = path.parse(this.sourcePath);
    this.outPath = path.join(parsed.dir, `${parsed.name}-audio.flac`);
  }

  async extract() {
    /* eslint-disable */
    const args = [
      '-i', this.sourcePath,
      '-sample_fmt', 's32',
      '-ar', '48000',
      '-map', 'a:0',
      '-c:a', 'flac',
      '-y',
      this.outPath,
    ];
    /* eslint-enable */

    await execa(FFMPEG_EXE, args);
  }

  async cleanup() {
    return new Promise<void>((resolve, reject) => {
      fs.unlink(this.outPath, e => {
        if (e) {
          console.log(e);
          reject();
          return;
        }

        resolve();
      });
    });
  }
}

export class FrameSource {
  writeBuffer = Buffer.allocUnsafe(FRAME_BYTE_SIZE);
  readBuffer = Buffer.allocUnsafe(FRAME_BYTE_SIZE);
  private byteIndex = 0;

  scrubJpg: string;

  readonly width = WIDTH;
  readonly height = HEIGHT;

  private ffmpeg: execa.ExecaChildProcess<string>;

  private onFrameComplete: (frameRead: boolean) => void;

  private finished = false;

  currentFrame = 0;

  get nFrames() {
    // Not sure why last frame is sometimes missing
    return Math.round(this.duration * FPS);
  }

  constructor(public readonly sourcePath: string, public readonly duration: number) {}

  async exportScrubbingSprite() {
    const parsed = path.parse(this.sourcePath);
    this.scrubJpg = path.join(SCRUB_SPRITE_DIRECTORY, `${parsed.name}-scrub.jpg`);

    /* eslint-disable */
    const args = [
      '-i', this.sourcePath,
      '-vf', `scale=${SCRUB_WIDTH}:${SCRUB_HEIGHT},fps=${SCRUB_FRAMES / this.duration},tile=${SCRUB_FRAMES}x1`,
      '-frames:v', '1',
      '-y',
      this.scrubJpg,
    ];
    /* eslint-enable */

    await execa(FFMPEG_EXE, args);
  }

  private startFfmpeg() {
    /* eslint-disable */
    const args = [
      '-i', this.sourcePath,
      '-vf', `fps=${FPS},scale=${this.width}:${this.height}`,
      '-map', 'v:0',
      '-vcodec', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-f', 'image2pipe',
      '-'
    ];
    /* eslint-enable */

    console.log(args);

    this.ffmpeg = execa(FFMPEG_EXE, args, {
      encoding: null,
      buffer: false,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: process.stderr,
    });

    this.ffmpeg.stdout.once('end', () => {
      console.log('STREAM HAS ENDED');
      console.log(`FRAME COUNT: Expected: ${this.nFrames} Actual: ${this.currentFrame}`);
      this.finished = true;

      // If a frame request is in progress, immediately resolve it
      if (this.onFrameComplete) this.onFrameComplete(false);
    });

    this.ffmpeg.stdout.on('data', (chunk: Buffer) => {
      // console.log('GOT CHUNK LENGTH', chunk.length);

      this.handleChunk(chunk);
    });

    this.ffmpeg.stdout.on('error', e => {
      console.log('error', e);
    });
  }

  /**
   * Attempts to read another frame into the readBuffer
   * @returns Returns true if a frame was read, otherwise false
   */
  readNextFrame(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      if (!this.ffmpeg) this.startFfmpeg();

      if (this.onFrameComplete) {
        console.log('Cannot read next frame while frame read is in progress');
        resolve(false);
        return;
      }

      // The stream was closed, so resolve that a frame could not be read.
      if (this.finished) {
        resolve(false);
        return;
      }

      this.onFrameComplete = resolve;

      this.ffmpeg.stdout.resume();
    });
  }

  private handleChunk(chunk: Buffer) {
    // If the chunk is larger than what's needed to fill the rest of the frame buffer,
    // only copy enough to fill the buffer.
    const bytesToCopy =
      this.byteIndex + chunk.length > FRAME_BYTE_SIZE
        ? FRAME_BYTE_SIZE - this.byteIndex
        : chunk.length;

    chunk.copy(this.writeBuffer, this.byteIndex, 0, bytesToCopy);
    this.byteIndex += bytesToCopy;

    if (this.byteIndex >= FRAME_BYTE_SIZE) {
      this.ffmpeg.stdout.pause();

      this.swapBuffers();

      this.currentFrame++;
      this.onFrameComplete(true);
      this.onFrameComplete = null;

      const remainingBytes = chunk.length - bytesToCopy;

      if (remainingBytes > 0) {
        chunk.copy(this.writeBuffer, this.byteIndex, bytesToCopy);
        this.byteIndex += remainingBytes;
      }
    }
  }

  /**
   * Swaps read and write buffers (front/back buffer)
   */
  private swapBuffers() {
    const newRead = this.writeBuffer;
    this.writeBuffer = this.readBuffer;
    this.readBuffer = newRead;
    this.byteIndex = 0;
  }
}

export class Clip {
  frameSource: FrameSource;
  audioSource: AudioSource;

  duration: number;

  initPromise: Promise<void>;

  constructor(public readonly sourcePath: string) {}

  /**
   * Performs all async operations needed to display
   * this clip to the user and starting working with it:
   * - Read duration
   * - Generate scrubbing sprite on disk
   */
  init() {
    if (!this.initPromise) {
      this.initPromise = new Promise<void>((resolve, reject) => {
        this.doInit()
          .then(resolve)
          .catch(reject);
      });
    }

    return this.initPromise;
  }

  private async doInit() {
    await this.readDuration();
    this.frameSource = new FrameSource(this.sourcePath, this.duration);
    this.audioSource = new AudioSource(this.sourcePath);
    await this.frameSource.exportScrubbingSprite();
  }

  private async readDuration() {
    if (this.duration) return;

    const { stdout } = await execa(FFPROBE_EXE, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      this.sourcePath,
    ]);
    this.duration = parseFloat(stdout);
  }
}

export class AudioCrossfader {
  constructor(public readonly outputPath: string, public readonly clips: Clip[]) {}

  async export() {
    const inputArgs = this.clips.reduce((args: string[], clip) => {
      return [...args, '-i', clip.audioSource.outPath];
    }, []);

    /* eslint-disable */
    const args = [
      ...inputArgs,
      '-filter_complex', this.getFilterGraph(),
      '-c:a', 'flac',
      '-y',
      this.outputPath,
    ];
    /* eslint-enable */

    await execa(FFMPEG_EXE, args);
  }

  getFilterGraph() {
    let inStream = '[0:a]';

    const filterGraph = this.clips
      .slice(0, -1)
      .map((clip, i) => {
        const outStream = `[concat${i}]`;

        let ret = `${inStream}[${i + 1}:a]acrossfade=d=${TRANSITION_DURATION}:c1=tri:c2=tri`;

        inStream = outStream;

        if (i < this.clips.length - 2) ret += outStream;

        return ret;
      })
      .join(',');

    return filterGraph;
  }

  async cleanup() {
    return new Promise<void>((resolve, reject) => {
      fs.unlink(this.outputPath, e => {
        if (e) {
          console.log(e);
          reject();
          return;
        }

        resolve();
      });
    });
  }
}

export class FrameWriter {
  constructor(public readonly outputPath: string, public readonly audioInput: string) {}

  readonly width = WIDTH;
  readonly height = HEIGHT;

  private ffmpeg: execa.ExecaChildProcess<string>;

  exitPromise: Promise<void>;

  private startFfmpeg() {
    /* eslint-disable */
    const args = [
      // Video Input
      '-f', 'rawvideo',
      '-vcodec', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${this.width}x${this.height}`,
      '-r', `${FPS}`,
      '-i', '-',

      // Audio Input
      '-i', this.audioInput,

      // Input Mapping
      '-map', '0:v:0',
      '-map', '1:a:0',

      // Video Output
      '-vf', 'format=yuv420p',
      '-vcodec', 'libx264',
      '-profile:v', 'high',
      '-preset:v', 'ultrafast',
      '-crf', '18',
      '-movflags', 'faststart',

      // Audio Output
      '-acodec', 'aac',
      '-b:a', '128k',

      '-y', this.outputPath,
    ];
    /* eslint-enable */

    console.log(args);

    this.ffmpeg = execa(FFMPEG_EXE, args, {
      encoding: null,
      buffer: false,
      stdin: 'pipe',
      stdout: process.stdout,
      stderr: 'pipe',
    });

    this.exitPromise = new Promise<void>(resolve => {
      this.ffmpeg.on('exit', code => {
        console.log('ffmpeg writer exited with code', code);
        resolve();
      });
    });

    this.ffmpeg.catch(e => {
      console.log('CAUGHT ERROR', e);
    });

    this.ffmpeg.stderr.on('data', (data: Buffer) => {
      console.log('ffmpeg stderr:', data.toString());
    });
  }

  async writeNextFrame(frameBuffer: Buffer) {
    if (!this.ffmpeg) this.startFfmpeg();

    await new Promise<void>((resolve, reject) => {
      this.ffmpeg.stdin.write(frameBuffer, e => {
        if (e) {
          console.log(e);
          reject();
          return;
        }
        resolve();
      });
    });
  }

  end() {
    this.ffmpeg.stdin.end();
    return this.exitPromise;
  }
}

export class Compositor2D {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d');

  readonly width = WIDTH;
  readonly height = HEIGHT;

  constructor() {
    this.canvas.width = this.width;
    this.canvas.height = this.height;
  }

  drawFrame(frame: Buffer) {
    const data = new ImageData(Uint8ClampedArray.from(frame), this.width, this.height);
    this.ctx.putImageData(data, 0, 0);
  }

  drawText() {
    this.ctx.font = '48px sans-serif';
    this.ctx.fillText('Hello World', 50, 50);
  }

  getFrame(): Buffer {
    return Buffer.from(this.ctx.getImageData(0, 0, this.width, this.height).data);
  }
}

export class Transitioner {
  private canvas = document.createElement('canvas');
  private gl = this.canvas.getContext('webgl');

  readonly width = WIDTH;
  readonly height = HEIGHT;

  private readBuffer = Buffer.allocUnsafe(FRAME_BYTE_SIZE);

  constructor() {
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.gl.viewport(0, 0, this.gl.canvas.width, this.gl.canvas.height);
  }

  renderTransition(fromFrame: Buffer, toFrame: Buffer, progress: number) {
    const buffer = createBuffer(
      this.gl,
      [-1, -1, -1, 4, 4, -1],
      this.gl.ARRAY_BUFFER,
      this.gl.STATIC_DRAW,
    );

    const transitionSrc = transitions.find((t: any) => t.name === 'wind');
    const transition = createTransition(this.gl, transitionSrc);

    this.gl.clear(this.gl.COLOR_BUFFER_BIT);

    const fromArray = this.convertFrame(fromFrame);
    const fromTexture = createTexture(this.gl, fromArray);
    fromTexture.minFilter = this.gl.LINEAR;
    fromTexture.magFilter = this.gl.LINEAR;

    const toArray = this.convertFrame(toFrame);
    const toTexture = createTexture(this.gl, toArray);
    fromTexture.minFilter = this.gl.LINEAR;
    fromTexture.magFilter = this.gl.LINEAR;

    buffer.bind();
    console.log('draw progress', progress);
    transition.draw(
      progress,
      fromTexture,
      toTexture,
      this.gl.drawingBufferWidth,
      this.gl.drawingBufferHeight,
    );

    fromTexture.dispose();
    toTexture.dispose();
  }

  getFrame(): Buffer {
    this.gl.readPixels(
      0,
      0,
      this.width,
      this.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      this.readBuffer,
    );

    return this.readBuffer;
  }

  private convertFrame(frame: Buffer) {
    return ndarray(frame, [this.width, this.height, 4], [4, this.width * 4, 1]);
  }
}

export interface IClip {
  path: string;
  loaded: boolean;
  enabled: boolean;
  scrubSprite?: string;
}

interface IHighligherState {
  clips: Dictionary<IClip>;
  clipOrder: string[];
}

class HighligherViews extends ViewHandler<IHighligherState> {
  /**
   * Returns an array of clips in their display order
   */
  get clips() {
    return this.state.clipOrder.map(p => this.state.clips[p]);
  }

  /**
   * Whether any clips need to be loaded
   */
  get loaded() {
    return !this.clips.some(c => !c.loaded);
  }

  get loadedCount() {
    let count = 0;

    this.clips.forEach(c => {
      if (c.loaded) count++;
    });

    return count;
  }
}

/**
 * Enable to use predefined clips instead of pulling from
 * the replay buffer.
 */
const TEST_MODE = true;

export class HighlighterService extends StatefulService<IHighligherState> {
  static initialState = {
    clips: {},
    clipOrder: [],
  } as IHighligherState;

  @Inject() streamingService: StreamingService;

  /**
   * A dictionary of actual clip classes.
   * These are not serializable so kept out of state.
   */
  clips: Dictionary<Clip> = {};

  directoryCleared = false;

  @mutation()
  ADD_CLIP(clip: IClip) {
    Vue.set(this.state.clips, clip.path, clip);
    this.state.clipOrder.push(clip.path);
  }

  @mutation()
  UPDATE_CLIP(clip: Partial<IClip> & { path: string }) {
    Vue.set(this.state.clips, clip.path, {
      ...this.state.clips[clip.path],
      ...clip,
    });
  }

  @mutation()
  SET_ORDER(order: string[]) {
    this.state.clipOrder = order;
  }

  get views() {
    return new HighligherViews(this.state);
  }

  init() {
    if (TEST_MODE) {
      const clipsToLoad = [
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-08-13.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-13-20.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-13-29.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-13-41.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-13-49.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-13-58.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-14-03.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-14-06.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-30-53.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-32-34.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-34-33.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-34-48.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-35-03.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-35-23.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-35-51.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-36-18.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-36-30.mp4'),
        path.join(CLIP_DIR, 'Replay 2021-03-30 14-36-44.mp4'),
      ];

      clipsToLoad.forEach(c => {
        this.ADD_CLIP({ path: c, loaded: false, enabled: true });
      });
    } else {
      this.streamingService.replayBufferFileWrite.subscribe(clipPath => {
        this.ADD_CLIP({ path: clipPath, loaded: false, enabled: true });
      });
    }
  }

  enableClip(path: string, enabled: boolean) {
    this.UPDATE_CLIP({
      path,
      enabled,
    });
  }

  setOrder(order: string[]) {
    this.SET_ORDER(order);
  }

  async loadClips() {
    await this.ensureScrubDirectory();

    // Ensure we have a Clip class for every clip in the store
    this.views.clips.forEach(c => {
      this.clips[c.path] = this.clips[c.path] ?? new Clip(c.path);
    });

    await pmap(this.views.clips, c => this.clips[c.path].init(), {
      concurrency: 5, // TODO
      onProgress: completed => {
        this.UPDATE_CLIP({
          path: completed.path,
          loaded: true,
          scrubSprite: this.clips[completed.path].frameSource.scrubJpg,
        });
      },
    });
  }

  private async ensureScrubDirectory() {
    // We clear this out once per application run
    if (this.directoryCleared) return;
    this.directoryCleared = true;

    await fs.remove(SCRUB_SPRITE_DIRECTORY);
    await fs.mkdir(SCRUB_SPRITE_DIRECTORY);
  }

  async run() {
    const clips = [new Clip(CLIP_1), new Clip(CLIP_2), new Clip(CLIP_3)];

    // Read all durations
    await Promise.all(clips.map(s => s.init()));

    // Mix audio first
    console.log('MIXING AUDIO');
    await Promise.all(clips.map(clip => clip.audioSource.extract()));
    const audioMix = `${EXPORT_NAME}-audio.flac`;
    const fader = new AudioCrossfader(audioMix, clips);
    await fader.export();
    await Promise.all(clips.map(clip => clip.audioSource.cleanup()));
    console.log('AUDIO DONE');

    let fromClip = clips.shift();
    let toClip = clips.shift();

    const transitioner = new Transitioner();

    const writer = new FrameWriter(`${EXPORT_NAME}.mp4`, audioMix);

    while (true) {
      const fromFrameRead = await fromClip.frameSource.readNextFrame();
      const inTransition =
        fromClip.frameSource.currentFrame >= fromClip.frameSource.nFrames - TRANSITION_FRAMES;
      let frameToRender = fromClip.frameSource.readBuffer;

      if (inTransition && toClip) {
        await toClip.frameSource.readNextFrame();

        transitioner.renderTransition(
          fromClip.frameSource.readBuffer,
          toClip.frameSource.readBuffer,

          // Frame counter refers to next frame we will read
          // Subtract 1 to get the frame we just read
          (toClip.frameSource.currentFrame - 1) / TRANSITION_FRAMES,
        );
        frameToRender = transitioner.getFrame();

        const transitionEnded = fromClip.frameSource.currentFrame === fromClip.frameSource.nFrames;

        if (transitionEnded) {
          fromClip = toClip;
          toClip = clips.shift();
        }
      }

      if (fromFrameRead) {
        await writer.writeNextFrame(frameToRender);
      } else {
        console.log('Out of sources, closing file');
        await writer.end();
        break;
      }
    }

    await fader.cleanup();
  }
}
