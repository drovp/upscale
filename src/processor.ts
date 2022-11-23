import * as Path from 'path';
import * as OS from 'os';
import {promises as FSP} from 'fs';
import type {ProcessorUtils} from '@drovp/types';
import type {Payload} from './';
import {checkSaveAsPathOptions, TemplateError, saveAsPath} from '@drovp/save-as-path';
import {ffprobe, ImageMeta, VideoMeta} from 'ffprobe-normalized';
import {
	eem,
	getFilename,
	getExtension,
	prepareEmptyDir,
	deletePath,
	makeDirCloneCleaner,
	Maid,
	execute,
	makeFfmpegProgressOrLogSplitter,
} from './utils';

const IS_WIN = process.platform === 'win32';

type Utils = ProcessorUtils<Dependencies>;

interface UpscaleResult {
	tmpPath: string;
	container: string;
}

export default async (payload: Payload, utils: Utils) => {
	const {input, options} = payload;
	const {dependencies, output} = utils;

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
	let result: UpscaleResult | void;

	switch (meta?.type) {
		case 'image': {
			result = await image(meta, {payload, utils});
			break;
		}

		case 'video': {
			result = await video(meta, {payload, utils});
			break;
		}

		default:
			throw new Error(`Unsupported file type.`);
	}

	if (result) {
		const {tmpPath, container} = result;
		const outputPath = await saveAsPath(input.path, tmpPath, container, options.saving);
		utils.output.file(outputPath);
	}
};

/**
 * Spawns one of the binaries to upscale in path to out path, and report the progress along the way.
 * Resolves with output scale, which might be different than requested (relesrgan has only 4x models).
 */
async function upscale(
	inPath: string,
	outPath: string,
	format: 'png' | 'jpg',
	{payload: {options}, utils}: {payload: Payload; utils: Utils}
): Promise<number> {
	let dependencyName: 'waifu2x' | 'realesrgan';
	const args: string[] = [];
	let scale = 1;

	utils.stage('upscaling');
	utils.progress(null);

	/**
	 * Determine if we're upscaling a directory, and clean up & prepare destination directory.
	 */
	const dirMode = (await FSP.stat(inPath)).isDirectory();
	if (dirMode) await prepareEmptyDir(outPath);

	/**
	 * Determine binary and construct arguments.
	 */
	switch (options.model) {
		// waifu2x
		case 'models-cunet':
		case 'models-upconv_7_anime_style_art_rgb':
		case 'models-upconv_7_photo':
			dependencyName = 'waifu2x';
			scale = parseInt(options.scale, 10);
			args.push('-m', options.model, '-n', options.denoise);
			args.push('-n', options.denoise);
			break;

		// realesrgan
		case 'realesr-animevideov3':
		case 'realesrgan-x4plus':
		case 'realesrgan-x4plus-anime':
			dependencyName = 'realesrgan';
			scale = options.model === 'realesr-animevideov3' && `${options.scale}` === '2' ? 2 : 4;
			args.push('-n', options.model);
			break;

		default:
			throw new Error(`Unknown model name "${options.model}"`);
	}

	args.push('-s', `${scale}`);
	args.push('-t', options.tileSize);
	args.push('-g', options.gpuId);
	if (options.loadProcSave) args.push('-j', options.loadProcSave);
	if (options.tta) args.push('-x');
	args.push('-f', format);
	args.push('-i', inPath, '-o', outPath);

	/**
	 * Upscale.
	 */
	const binPath = utils.dependencies[dependencyName];
	const dirProgressDisposer = dirMode ? makeDirCloneCleaner(inPath, outPath, {onProgress: utils.progress}) : null;
	const logOrProgress = (data: Buffer) => {
		const message = `${data}`;
		const percentMatch = message.match(/\s?(?<percent>\d+(\.\d+)?)%\s?/);
		if (percentMatch) {
			if (!dirProgressDisposer) utils.progress(parseInt(`${percentMatch.groups?.percent}`, 10) || 0, 100);
		} else {
			utils.log(message);
		}
	};

	try {
		await execute(binPath, args, {cwd: Path.dirname(inPath), onStderr: logOrProgress});
		return scale;
	} finally {
		dirProgressDisposer?.();
	}
}

/**
 * Upscale image input.
 */
async function image(input: ImageMeta, context: {payload: Payload; utils: Utils}): Promise<UpscaleResult | void> {
	const {payload, utils} = context;
	const {id, options} = payload;
	const outputScale = parseInt(options.scale, 10) || 2;
	const {dependencies, log} = utils;
	const {image: imageOptions} = options;
	const dirname = Path.dirname(input.path);
	const filename = getFilename(input.path);
	let workingPath = input.path;
	const maid = new Maid();

	// If source format is not supported, convert it to png
	if (!['png', 'jpg', 'webp'].includes(input.container)) {
		log(`Input type "${input.container}" is not supported as an input, converting to temporary png...`);

		const filename = getFilename(input.path);
		const tmpPath = Path.join(Path.dirname(workingPath), `${filename}-tmp-converted-${id}.png`);

		log(`creating: "${tmpPath}"`);

		try {
			maid.task(() => deletePath(tmpPath));
			await execute(dependencies.ffmpeg, ['-y', '-i', workingPath, '-c:v', 'png', '-f', 'image2', tmpPath], {
				cwd: dirname,
				onLog: log,
			});
			workingPath = tmpPath;
		} catch (error) {
			utils.output.error(`Can't convert file to png, error: ${eem(error)}`);
			await maid.cleanup();
			return;
		}
	}

	let currentScale = 1;
	let result: UpscaleResult | void;
	let rescaleFilter: string | undefined;

	try {
		let tmpPath = Path.join(dirname, `${filename}-tmp-${id}.png`);
		currentScale = await upscale(workingPath, tmpPath, 'png', context);
		utils.progress(100, 100, true);
		workingPath = tmpPath;
		log(`current scale: ${currentScale}x`);
	} catch (error) {
		utils.output.error(eem(error));
		return;
	} finally {
		await maid.cleanup();
	}

	log(`currentScale, outputScale:`, currentScale, outputScale);
	if (currentScale !== outputScale) {
		const outputWidth = Math.round(input.width * outputScale);
		const outputHeight = Math.round(input.height * outputScale);
		rescaleFilter = `scale=${outputWidth}:${outputHeight}:flags=lanczos:force_original_aspect_ratio=disable`;
	}

	const outPath = Path.join(dirname, `${filename}.tmp-out-${id}`);
	let ffmpegJob: {args: string[]; container: string} | undefined;

	switch (imageOptions.format) {
		case 'jpg': {
			log('Converting to jpg...');
			const args: string[] = [];
			const filterComplex: string[] = [];

			// Input file
			args.push('-i', workingPath);

			// Creates background stream to be layed below input image
			// `-f lavfi` forces required format for following input
			args.push('-f', 'lavfi', '-i', `color=c=${imageOptions.jpg.background}`);

			// Overlay filter
			filterComplex.push(
				'[1:v][0:v]scale2ref[bg][image]',
				'[bg]setsar=1[bg]',
				`[bg][image]overlay=shortest=1,format=yuv420p[${rescaleFilter ? 'prescaled' : 'out'}]`
			);

			if (rescaleFilter) {
				log(`downscaling to: ${outputScale}x`);
				filterComplex.push(`[prescaled]${rescaleFilter}[out]`);
			}

			// Apply filters
			args.push('-filter_complex', filterComplex.join(';'));

			// Select out stream
			args.push('-map', '[out]');

			// Codec and quality
			args.push('-c:v', 'mjpeg');
			args.push('-qmin', '1'); // qscale is capped to 2 by default apparently
			args.push('-qscale:v', `${imageOptions.jpg.quality}`, '-huffman', 'optimal');

			// Output
			args.push('-f', 'image2');
			args.push(outPath);

			ffmpegJob = {args, container: 'jpg'};

			break;
		}

		case 'webp': {
			log('Converting to webp...');
			const args: string[] = [];

			// Input file
			args.push('-i', workingPath);

			if (rescaleFilter) {
				log(`downscaling to: ${outputScale}x`);
				args.push('-vf', rescaleFilter);
			}

			// Codec and quality
			args.push('-c:v', 'libwebp');
			args.push('-qscale:v', `${imageOptions.webp.quality}`);
			args.push('-compression_level', '6');
			args.push('-preset', imageOptions.webp.preset);

			// Output
			args.push('-f', 'image2', outPath);

			ffmpegJob = {args, container: 'webp'};

			break;
		}

		default: {
			if (rescaleFilter) {
				log(`downscaling to: ${outputScale}x`);
				const args: string[] = [];

				// Input file
				args.push('-i', workingPath);
				args.push('-filter_complex', `[0:v]${rescaleFilter}[out]`);
				args.push('-map', '[out]');
				args.push('-c:v', 'png');

				// Output
				args.push('-f', 'image2', outPath);

				ffmpegJob = {args, container: 'png'};
			}
		}
	}

	if (ffmpegJob) {
		// Execute ffmpeg
		try {
			await execute(dependencies.ffmpeg, ['-y', ...ffmpegJob.args], {cwd: dirname, onLog: log});
			await deletePath(workingPath);
			result = {tmpPath: outPath, container: ffmpegJob.container};
		} catch (error) {
			utils.output.error(eem(error));
			maid.task(() => deletePath(outPath));
		}
	} else {
		result = {tmpPath: workingPath, container: 'png'};
	}

	await maid.cleanup();

	return result;
}

/**
 * Upscale a video.
 * Destination path has to have a png, jpg, or webp extension at the end.
 */
async function video(
	input: VideoMeta,
	{payload, utils}: {payload: Payload; utils: Utils}
): Promise<UpscaleResult | void> {
	const {id, options} = payload;
	const outputScale = parseInt(options.scale, 10) || 2;
	const {dependencies, log, progress, stage} = utils;
	const {video: videoOptions} = options;
	const directory = Path.dirname(input.path);
	const filename = getFilename(input.path);
	const inputExtension = getExtension(input.path);
	const framesDirectory = Path.join(Path.dirname(input.path), `[frames-${id}]`);
	const framesInDirectory = Path.join(framesDirectory, `in`);
	const framesOutDirectory = Path.join(framesDirectory, `out`);
	const maid = new Maid();

	// Create directory for storing frames
	log(`Creating directories for storing frames...\n IN: "${framesInDirectory}"\nOUT: "${framesInDirectory}"`);
	await prepareEmptyDir(framesInDirectory);
	await prepareEmptyDir(framesOutDirectory);
	maid.task(async () => {
		log(`Deleting frames directory...`);
		await deletePath(framesDirectory);
	});

	// Extract frames
	stage('extracting frames');
	const frameExtractionCodecArgs =
		videoOptions.framesFormat === 'jpg'
			? ['-c:v', 'mjpeg', '-q:v', '1', '-qmin', '1', '-qmax', '1']
			: ['-c:v', 'png'];
	const frameFileTemplate = `%08d.${videoOptions.framesFormat}`;
	try {
		await execute(dependencies.ffmpeg, ['-y', '-i', input.path, ...frameExtractionCodecArgs, frameFileTemplate], {
			cwd: framesInDirectory,
			onLog: makeFfmpegProgressOrLogSplitter(progress, log),
		});
	} catch (error) {
		utils.output.error(`Couldn't extract frames from video. See logs for more details.`);
		await maid.cleanup();
		return;
	}

	progress(null);

	let currentScale = 1;
	let rescaleFilter: string | undefined;

	// Upscale frames
	try {
		currentScale = await upscale(framesInDirectory, framesOutDirectory, videoOptions.framesFormat, {
			payload,
			utils,
		});
	} catch (error) {
		utils.output.error(`Upscaling frames failed. See logs for more details.`);
		await maid.cleanup();
		return;
	}

	if (currentScale !== outputScale) {
		const outputWidth = Math.round((input.width * outputScale) / 2) * 2;
		const outputHeight = Math.round((input.height * outputScale) / 2) * 2;
		rescaleFilter = `scale=${outputWidth}:${outputHeight}:flags=lanczos:force_original_aspect_ratio=disable`;
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
		inputArgs.push('-i', Path.join(framesOutDirectory, frameFileTemplate));
		inputArgs.push('-r', input.framerate);

		// Filters
		const filters: string[] = ['yadif=deint=interlaced'];

		// Set pixel format, forced to yuva420p for gif or it removes transparency
		filters.push(`format=${outputContainer !== 'gif' ? 'yuva420p' : videoOptions.pixelFormat}`);
		if (rescaleFilter) filters.push(rescaleFilter);

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
				videoArgs.push('-c:v', 'libsvtav1');

				const svtav1Params: string[] = [];

				// Preset
				svtav1Params.push(`preset=${videoOptions.av1.preset}`);
				svtav1Params.push(`crf=${videoOptions.av1.crf}`);

				// Keyframe interval
				svtav1Params.push(`keyint=${Math.round(input.framerate * videoOptions.av1.keyframeInterval)}`);
				if (videoOptions.av1.sceneDetection) svtav1Params.push('scd=1');

				// Film grain synthesis
				if (videoOptions.av1.filmGrainSynthesis > 0) {
					svtav1Params.push(`film-grain=${videoOptions.av1.filmGrainSynthesis}`);
				}

				videoArgs.push('-svtav1-params', svtav1Params.join(':'));

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
		videoArgs.push('-filter_complex', `[1:v:0]${filters.join(',')}[out]`);

		// Streams
		inputArgs.push('-map', '[out]');
		if (input.audioStreams.length > 0) inputArgs.push('-map', '0:a?');
		if (hasSubtitles && outputContainer === 'mkv') {
			inputArgs.push('-map', '0:s?');
			inputArgs.push('-map', '0:t?');
		}

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
			maid.task(async () => {
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
			try {
				await execute(
					dependencies.ffmpeg,
					[...inputArgs, ...videoArgs, ...twoPass.args[0], '-an', '-f', 'null', IS_WIN ? 'NUL' : '/dev/null'],
					{cwd: directory, onLog: makeFfmpegProgressOrLogSplitter(progress, log)}
				);
			} catch (error) {
				utils.output.error(`1st encoding pass failed. See logs for more details.`);
				return;
			}

			// Enable second pass for final encode
			outputArgs.push(...twoPass.args[1]);
			stage('pass 2');
		}

		// Enforce output type
		outputArgs.push('-f', outputFormat);

		// Finally, encode the file
		const tmpPath = Path.join(directory, `${filename}.tmp${id}`);
		try {
			await execute(
				dependencies.ffmpeg,
				['-y', '-loglevel', 'verbose', ...inputArgs, ...videoArgs, ...audioArgs, ...outputArgs, tmpPath],
				{
					cwd: directory,
					onLog: makeFfmpegProgressOrLogSplitter(progress, log),
				}
			);
			return {tmpPath: tmpPath, container: outputContainer};
		} catch (error) {
			maid.task(() => deletePath(tmpPath));
			utils.output.error(`Encoding failed. See logs for more details.`);
		}
	} finally {
		stage('cleaning up');
		await maid.cleanup();
	}
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
