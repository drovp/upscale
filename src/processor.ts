import * as Path from 'path';
import * as OS from 'os';
import {promises as FSP} from 'fs';
import {spawn} from 'child_process';
import type {ProcessorUtils, Progress} from '@drovp/types';
import type {Payload, Options} from './';
import {checkSaveAsPathOptions, TemplateError, saveAsPath} from '@drovp/save-as-path';
import {ffprobe, ImageData, VideoData} from 'ffprobe-normalized';

const IS_WIN = process.platform === 'win32';

// Potential processor dependency payloads must be defined manually
interface Dependencies {
	waifu2x: string;
	ffmpeg: string;
	ffprobe: string;
}

type Utils = ProcessorUtils<Dependencies>;

export default async (payload: Payload, utils: Utils) => {
	const {input, options} = payload;
	const {dependencies, output} = utils;
	let outputPath: string;

	// First, we check that options have a valid destination template.
	try {
		checkSaveAsPathOptions(options.saving);
	} catch (error) {
		if (error instanceof TemplateError) {
			output.error(`Destination template error: ${error.message}`);
			return;
		}
	}

	const meta = await ffprobe(input.path, {path: dependencies.ffprobe});

	switch (meta?.type) {
		case 'image': {
			let tmpPath = await image(meta, {payload, utils});
			outputPath = await saveAsPath(input.path, tmpPath, options.image.format, options.saving);
			break;
		}

		case 'video': {
			const {path, container} = await video(meta, {payload, utils});
			outputPath = await saveAsPath(input.path, path, container, options.saving);
			break;
		}

		default:
			throw new Error(`Unsupported file type.`);
	}

	// We emit a new file
	utils.output.file(outputPath);
};

/**
 * Upscale a single image.
 * Filename is the desired filename WITHOUT the extension, which will always be PNG.
 */
async function upscaleImage(
	input: Pick<ImageData, 'path' | 'container'>,
	filename: string,
	{
		dependencies,
		log,
		...options
	}: Pick<Options, 'scale' | 'denoise' | 'model' | 'tileSize' | 'gpuId' | 'loadProcSave' | 'tta'> & {
		dependencies: Dependencies;
		log: (message: string) => void;
	}
) {
	const args: string[] = [];
	let sourcePath = input.path;
	const dirname = Path.dirname(input.path);
	const destinationPath = Path.join(dirname, `${filename}.png`);
	const cleanups: (() => any)[] = [];

	// If source format is not supported by waifu2x, convert it to png
	if (!['png', 'jpg', 'webp'].includes(input.container)) {
		log(`Input type "${input.container}" is not supported as waifu2x input, converting to temporary png...`);
		const filename = getFilename(input.path);
		const tmpPath = Path.join(Path.dirname(sourcePath), `${filename}-tmp${uid()}.png`);
		log(`creating: "${tmpPath}"`);
		await execute(dependencies.ffmpeg, ['-y', '-i', sourcePath, '-c:v', 'png', '-f', 'image2', tmpPath], {
			cwd: dirname,
			log,
		});
		sourcePath = tmpPath;
		cleanups.push(() => FSP.rm(tmpPath));
	}

	// Options
	args.push('-s', options.scale);
	args.push('-n', options.denoise);
	args.push('-m', options.model);
	args.push('-t', options.tileSize);
	args.push('-g', options.gpuId);
	if (options.loadProcSave) args.push('-j', options.loadProcSave);
	if (options.tta) args.push('-x');

	// Input & Output
	args.push('-f', 'png');
	args.push('-i', sourcePath);
	args.push('-o', destinationPath);

	try {
		// Execute waifu2x binary
		await execute(dependencies.waifu2x, args, {cwd: dirname, log});
		return destinationPath;
	} finally {
		// Cleanup
		for (const step of cleanups) {
			try {
				await step();
			} catch {}
		}
	}
}

/**
 * Upscale image input.
 */
async function image(input: ImageData, {payload, utils}: {payload: Payload; utils: Utils}) {
	const {id, options} = payload;
	const {dependencies, log} = utils;
	const {image: imageOptions} = options;
	const dirname = Path.dirname(input.path);
	const filename = getFilename(input.path);

	let tmpPath = await upscaleImage(input, `${filename}-tmp${id}`, {...options, ...utils});

	switch (imageOptions.format) {
		case 'jpg': {
			log('Converting to jpg...');
			const args: (string | number)[] = ['-y'];
			const filterComplex: string[] = [];

			// Input file
			args.push('-i', tmpPath);

			// Creates background stream to be layed below input image
			// `-f lavfi` forces required format for following input
			args.push('-f', 'lavfi', '-i', `color=c=${imageOptions.jpg.background}`);

			// Overlay filter
			filterComplex.push(
				'[1:v][0:v]scale2ref[bg][image]',
				'[bg]setsar=1[bg]',
				'[bg][image]overlay=shortest=1,format=yuv420p[out]'
			);

			// Apply filters
			args.push('-filter_complex', filterComplex.join(';'));

			// Select out stream
			args.push('-map', '[out]');

			// Codec and quality
			args.push('-c:v', 'mjpeg');
			args.push('-qmin', '1'); // qscale is capped to 2 by default apparently
			args.push('-qscale:v', imageOptions.jpg.quality, '-huffman', 'optimal');

			// Output
			const jpgPath = Path.join(dirname, `${filename}.tmp${id}`);
			args.push('-f', 'image2');
			args.push(jpgPath);

			// Execute ffmpeg
			await execute(dependencies.ffmpeg, args, {cwd: dirname, log});
			await FSP.rm(tmpPath);
			return jpgPath;
		}

		case 'webp': {
			const args: (string | number)[] = ['-y'];
			// Input file
			args.push('-i', tmpPath);

			// Codec and quality
			args.push('-c:v', 'libwebp');
			args.push('-qscale:v', imageOptions.webp.quality);
			args.push('-compression_level', '6');
			args.push('-preset', imageOptions.webp.preset);

			// Output
			const webpPath = Path.join(dirname, `${filename}.tmp${id}`);
			args.push('-f', 'image2');
			args.push(webpPath);

			// Execute ffmpeg
			await execute(dependencies.ffmpeg, args, {cwd: dirname, log});
			await FSP.rm(tmpPath);
			return webpPath;
		}

		default:
			return tmpPath;
	}
}

/**
 * Upscale a video.
 * Destination path has to have a png, jpg, or webp extension at the end.
 */
async function video(input: VideoData, {payload, utils}: {payload: Payload; utils: Utils}) {
	const {id, options} = payload;
	const {dependencies, log, progress, stage} = utils;
	const {video: videoOptions} = options;
	const directory = Path.dirname(input.path);
	const filename = getFilename(input.path);
	const inputExtension = getExtension(input.path);
	const framesDirectory = Path.join(Path.dirname(input.path), `[FRAMES-${id}] ${filename}`);
	const cleanups: (() => any)[] = [];

	// Create directory for storing frames
	log(`Creating directory for storing frames at "${framesDirectory}"`);
	await FSP.mkdir(framesDirectory);
	cleanups.push(async () => {
		log(`Deleting frames directory...`);
		await FSP.rm(framesDirectory, {recursive: true, force: true});
	});

	// Extract frames
	stage('extracting frames');
	await execute(dependencies.ffmpeg, ['-y', '-i', input.path, '%08d.png'], {
		cwd: framesDirectory,
		log: ffmpegProgressOrLog(progress, log),
	});

	progress(null);

	// Upscale frames
	stage('upscaling frames');
	const frameFiles = await FSP.readdir(framesDirectory);
	for (let i = 0; i < frameFiles.length; i++) {
		progress(i, frameFiles.length);
		const file = frameFiles[i]!;
		const filePath = Path.join(framesDirectory, file);
		const filename = getFilename(file);
		await upscaleImage({path: filePath, container: 'png'}, `${filename}_2x`, {...options, ...utils});
		await FSP.rm(filePath);
	}

	progress(null);

	try {
		stage('encoding video');

		const inputArgs: (string | number)[] = [];
		const videoArgs: (string | number)[] = [];
		const audioArgs: (string | number)[] = [];
		const outputArgs: (string | number)[] = [];
		const hasSubtitles = input.subtitlesStreams.length > 0;
		const inputContainer =
			// This container ID is shared between mkv and webm, so we need to
			// normalize it further.
			input.container === 'matroska,webm'
				? inputExtension === 'mkv' || hasSubtitles
					? 'mkv'
					: 'webm'
				: input.container;
		const outputContainer =
			hasSubtitles && videoOptions.ensureSubtitles
				? 'mkv'
				: videoOptions.inheritContainer && ['mp4', 'webm', 'mkv', 'gif'].includes(inputContainer)
				? (inputContainer as 'mp4' | 'webm' | 'mkv' | 'gif')
				: videoOptions.preferredContainer;
		const outputFormat = outputContainer === 'mkv' ? 'matroska' : outputContainer;
		const outputCodec = {
			mp4: videoOptions.mp4Codec,
			webm: videoOptions.webmCodec,
			mkv: videoOptions.mkvCodec,
			gif: 'gif' as const,
		}[outputContainer];
		let twoPass: false | TwoPassData = false;

		// Input
		inputArgs.push('-r', input.framerate);
		inputArgs.push('-i', input.path);
		inputArgs.push('-r', input.framerate);
		inputArgs.push('-i', `${framesDirectory}/%08d_2x.png`);
		inputArgs.push('-r', input.framerate);

		// Streams
		inputArgs.push('-map', '1:v:0');
		inputArgs.push('-map', '0:a?');
		if (hasSubtitles && outputContainer === 'mkv') {
			inputArgs.push('-map', '0:s?');
			inputArgs.push('-map', '0:t?');
		}

		// Filters
		const filters: string[] = [];

		// Set pixel format, ignored for gif or it removes transparency
		if (outputContainer !== 'gif') filters.push(`format=${videoOptions.pixelFormat}`);

		// Codec specific args
		switch (outputCodec) {
			case 'h264':
				videoArgs.push('-c:v', 'libx264');
				videoArgs.push('-preset', videoOptions.h264.preset);
				if (videoOptions.h264.tune) videoArgs.push('-tune', videoOptions.h264.tune);
				if (videoOptions.h264.profile !== 'auto') videoArgs.push('-profile', videoOptions.h264.profile);
				videoArgs.push('-crf', videoOptions.h264.crf);
				break;

			case 'h265':
				videoArgs.push('-c:v', 'libx265');
				videoArgs.push('-preset', videoOptions.h265.preset);
				if (videoOptions.h265.tune) videoArgs.push('-tune', videoOptions.h265.tune);
				if (videoOptions.h265.profile !== 'auto') videoArgs.push('-profile', videoOptions.h265.profile);
				videoArgs.push('-crf', videoOptions.h265.crf);
				break;

			case 'vp8':
				videoArgs.push('-c:v', 'libvpx');
				if (videoOptions.vp8.speed) videoArgs.push('-speed', videoOptions.vp8.speed);
				videoArgs.push('-crf', videoOptions.vp8.crf);
				videoArgs.push('-qmin', videoOptions.vp8.qmin);
				videoArgs.push('-qmax', videoOptions.vp8.qmax);

				// Encoding GIFs without this fails, no idea if disabling this
				// is bad, but definitely not as bad as errors.
				videoArgs.push('-auto-alt-ref', 0);

				if (videoOptions.vp8.twoPass) twoPass = makeTwoPass(id);

				break;

			case 'vp9':
				videoArgs.push('-c:v', 'libvpx-vp9');
				videoArgs.push('-quality', 'good');
				videoArgs.push('-crf', videoOptions.vp9.crf, '-b:v', 0);
				videoArgs.push('-qmin', videoOptions.vp9.qmin);
				videoArgs.push('-qmax', videoOptions.vp9.qmax);

				// Multithreading
				if (videoOptions.vp9.threads > 1) {
					videoArgs.push('-threads', videoOptions.vp9.threads);
					videoArgs.push('-tile-columns', videoOptions.vp9.threads);
				}

				if (videoOptions.vp9.twoPass) {
					twoPass = makeTwoPass(id);
					twoPass.args[0].push('-speed', 4);
					twoPass.args[1].push('-speed', videoOptions.vp9.speed);
				} else {
					videoArgs.push('-speed', videoOptions.vp9.speed);
				}

				break;

			case 'av1':
				videoArgs.push('-c:v', 'libaom-av1');
				videoArgs.push('-crf', videoOptions.av1.crf, '-b:v', 0);
				videoArgs.push('-qmin', videoOptions.av1.qmin);
				videoArgs.push('-qmax', videoOptions.av1.qmax);

				// Max keyframe interval
				if (videoOptions.av1.maxKeyframeInterval) {
					videoArgs.push('-g', Math.round(input.framerate * videoOptions.av1.maxKeyframeInterval));
				}

				videoArgs.push('-cpu-used', videoOptions.av1.speed);
				if (videoOptions.av1.multithreading) videoArgs.push('-row-mt', 1);
				if (videoOptions.av1.twoPass) twoPass = makeTwoPass(id);

				break;

			case 'gif':
				filters.push(
					[
						`split[o1][o2]`,
						`[o1]palettegen=max_colors=${videoOptions.gif.colors}[p]`,
						`[o2]fifo[o3]`,
						`[o3][p]paletteuse=dither=${videoOptions.gif.dithering}`,
					].join(';')
				);
				break;
		}

		// Apply filters
		if (filters.length > 0) videoArgs.push('-vf', `${filters.join(',')}`);

		// Audio
		if (input.audioStreams.length > 0 && outputContainer !== 'gif') {
			if (input.container === outputContainer) {
				audioArgs.push('-c:a', 'copy');
			} else {
				audioArgs.push('-c:a', videoOptions.audioCodec);

				// Set audio bitrate for each stream
				for (const [index, audioChannel] of input.audioStreams.entries()) {
					audioArgs.push(`-b:a:${index}`, `${videoOptions.audioChannelBitrate * audioChannel.channels}k`);
				}
			}
		}

		// Two pass encoding
		if (twoPass) {
			const {logFiles} = twoPass;
			cleanups.push(async () => {
				log(`Deleting 2 pass log files...`);
				for (const path of logFiles) {
					try {
						log(`→ "${path}"`);
						await FSP.rm(path, {recursive: true, force: true});
					} catch {}
				}
			});
			stage('pass 1');

			// First pass to null with no audio
			await execute(
				dependencies.ffmpeg,
				[...inputArgs, ...videoArgs, ...twoPass.args[0], '-an', '-f', 'null', IS_WIN ? 'NUL' : '/dev/null'],
				{cwd: directory, log: ffmpegProgressOrLog(progress, log)}
			);

			// Enable second pass for final encode
			outputArgs.push(...twoPass.args[1]);
			stage('pass 2');
		}

		// Enforce output type
		outputArgs.push('-f', outputFormat);

		// Finally, encode the file
		const tmpPath = Path.join(directory, `${filename}.tmp${id}`);
		await execute(dependencies.ffmpeg, [...inputArgs, ...videoArgs, ...audioArgs, ...outputArgs, tmpPath], {
			cwd: directory,
			log: ffmpegProgressOrLog(progress, log),
		});

		return {path: tmpPath, container: outputContainer};
	} finally {
		stage('cleaning up');
		// Cleanup
		for (const step of cleanups) {
			try {
				await step();
			} catch {}
		}
	}
}

function execute(
	binPath: string,
	args: (string | number)[],
	{log, cwd}: {log?: (message: string) => void; cwd?: string} = {}
) {
	return new Promise<void>((resolve, reject) => {
		const finalArgs = args.map(toString);

		log?.(`Executing binary:
----------------------------------------
→ bin: "${binPath}"
→ params: ${finalArgs.map(argToParam).join(' ')}
→ cwd: "${cwd}"
----------------------------------------`);

		const cp = spawn(binPath, finalArgs, {cwd});
		let stdout = '';
		let stderr = '';

		cp.stdout.on('data', (data: Buffer) => {
			const message = data.toString();
			stdout += message;
			log?.(message);
		});
		cp.stderr.on('data', (data: Buffer) => {
			const message = data.toString();
			stderr += message;
			log?.(message);
		});

		let done = (err?: Error | null, code?: number | null) => {
			done = () => {};
			if (err) {
				reject(err);
			} else if (code != null && code > 0) {
				reject(new Error(`Process exited with code ${code}.\n\n${stderr || stdout}`));
			} else {
				resolve();
			}
		};

		cp.on('error', (err) => done(err));
		cp.on('close', (code) => done(null, code));
	});
}

/**
 * Helper to converts params into strings as they'd be seen when uses in a console.
 */
function argToParam(value: string) {
	return value[0] === '-' ? value : value.match(/[^a-zA-Z0-9\-_]/) ? `"${value}"` : value;
}

const toString = (value: any) => `${value}`;
const uid = (size = 6) => Math.random().toString().slice(-size);
const getFilename = (path: string) => Path.basename(path, Path.extname(path));

function getExtension(path: string) {
	const extname = Path.extname(path).trim().slice(1).toLocaleLowerCase();
	return extname === 'jpeg' ? 'jpg' : extname;
}

/**
 * FFmpeg std parser that extracts progress and logs the rest.
 */
function ffmpegProgressOrLog(progress: Progress, log: (message: string) => void) {
	let recentOutput = '';
	let duration = 0;
	let durationWontHappen = false;

	return (message: string) => {
		// Keep track of recent output, as some messages that need to be parsed
		// sometimes arrive in separate std events.
		recentOutput = (recentOutput + message).slice(-1000);

		// Take over progress reports
		const trimmedMessage = message.trim();
		if (trimmedMessage.startsWith('frame=') || trimmedMessage.startsWith('size=')) {
			durationWontHappen = true;

			if (duration) {
				const timeMatch = /time=([\d\:\.]+)/.exec(message)?.[1];

				if (timeMatch) {
					const milliseconds = humanTimeToMS(timeMatch);
					if (milliseconds <= duration) progress(milliseconds, duration);
				}
			}

			return;
		}

		// Attempt to extract duration if it wasn't yet, and we are still expecting it
		if (!duration && !durationWontHappen) {
			const durationMatch = /^ *Duration: *([\d\:\.]+),/m.exec(recentOutput)?.[1];
			if (durationMatch) duration = humanTimeToMS(durationMatch) || 0;
		}

		log?.(message);
	};
}

/**
 * '1:30:40.500' => {milliseconds}
 */
export function humanTimeToMS(text: string) {
	const split = text.split('.') as [string, string | undefined];
	let time = split[1] ? parseFloat(`.${split[1]}`) * 1000 : 0;
	const parts = split[0]
		.split(':')
		.filter((x) => x)
		.map((x) => parseInt(x, 10));

	if (parts.length > 0) time += parts.pop()! * 1000; // s
	if (parts.length > 0) time += parts.pop()! * 1000 * 60; // m
	if (parts.length > 0) time += parts.pop()! * 1000 * 60 * 60; // h

	return time;
}

export interface TwoPassData {
	args: [(string | number)[], (string | number)[]];
	logFiles: string[];
}

/**
 * Returns parameter pairs to enable 2 pass encoding.
 */
function makeTwoPass(id: string, extraArgs?: (string | number)[]): TwoPassData {
	const twoPassLogFileId = Path.join(OS.tmpdir(), `drovp-upscale-passlogfile-${id}`);
	return {
		args: [
			['-pass', 1, '-passlogfile', twoPassLogFileId, ...(extraArgs || [])],
			['-pass', 2, '-passlogfile', twoPassLogFileId, ...(extraArgs || [])],
		],
		logFiles: [`${twoPassLogFileId}-0.log`],
	};
}
