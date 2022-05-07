import * as CP from 'child_process';
import * as Path from 'path';
import {promises as FSP, constants as FSC} from 'fs';
import {
	Plugin,
	PayloadData,
	OptionsSchema,
	makeAcceptsFlags,
	LoadUtils,
	InstallUtils,
	DependencyData,
} from '@drovp/types';
import {makeOptionSchema, Options as SaveAsOptions} from '@drovp/save-as-path';

const RELEASES_LIMIT = 10;
const API_RELEASES_ENDPOINT = `https://api.github.com/repos/nihui/waifu2x-ncnn-vulkan/releases`;
const VERSION_FILE = 'version.txt';
const BIN = `waifu2x-ncnn-vulkan${process.platform === 'win32' ? '.exe' : ''}`;

interface ReleaseData {
	tag_name: string; // '20220419'
	name: string; // 'Release 20220419'
	created_at: string; // '2022-04-19T14:01:31Z'
	published_at: string; // '2022-04-19T14:18:00Z'
	assets?: AssetData[];
}

interface AssetData {
	url: string; // 'https://api.github.com/repos/nihui/waifu2x-ncnn-vulkan/releases/assets/63004367'
	id: number; // 63004367
	node_id: string; // 'RA_kwDOCq_5MM4DwV7P'
	name: string; // 'waifu2x-ncnn-vulkan-20220419-macos.zip'
	content_type: string; // 'application/zip'
	size: number; // 41035111
	created_at: string; // '2022-04-19T14:18:02Z'
	updated_at: string; // '2022-04-19T14:18:03Z'
	browser_download_url: string; // 'https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/20220419/waifu2x-ncnn-vulkan-20220419-macos.zip'
}

async function loadDependency(utils: LoadUtils): Promise<DependencyData<string>> {
	const versionPath = Path.join(utils.dataPath, VERSION_FILE);
	const binPath = Path.join(utils.dataPath, BIN);
	const version = (await FSP.readFile(versionPath, {encoding: 'utf-8'})).trim();

	await FSP.access(binPath, FSC.X_OK);

	return {version, payload: binPath};
}

async function installDependency(utils: InstallUtils) {
	switch (process.platform) {
		case 'darwin':
			await installRelease('macos', utils);
			break;

		case 'linux':
			await installRelease('ubuntu|linux', utils);
			break;

		case 'win32':
			await installRelease('windows|win', utils);
			break;
	}
}

/**
 * Usage:
 * ```
 * await installRelease('windows', utils);
 * await installRelease('macos', utils);
 * await installRelease('ubuntu|linux', utils);
 * ```
 */
async function installRelease(
	archiveSuffix: string,
	{dataPath, tmpPath, download, extract, fetchJson, cleanup, progress, stage, log}: InstallUtils
) {
	stage('resolving');
	log(`API: ${API_RELEASES_ENDPOINT}`);

	const releases = await fetchJson<ReleaseData[]>(`${API_RELEASES_ENDPOINT}?per_page=${RELEASES_LIMIT}`, {
		headers: {accepts: 'application/vnd.github.v3+json'},
	});

	log(`Received ${releases.length} newest releases. Looking for the lates package for "${archiveSuffix}" suffix...`);

	const assetRegExp = new RegExp(`-(${archiveSuffix})\\.\\w+$`, 'i');
	let data: {version: string; url: string} | undefined;

	for (const release of releases) {
		const assets = release.assets || [];
		log(`----------\nRelease: ${release.tag_name}\nAssets:\n→ ${assets.map(({name}) => name).join(`\n→ `)}`);
		const asset = assets.find((asset) => assetRegExp.exec(asset.name) != null);
		if (asset) {
			log(`Matched: ${asset.name}\nURL: ${asset.browser_download_url}`);
			data = {
				version: release.tag_name,
				url: asset.browser_download_url,
			};
			break;
		} else {
			log(`No match.`);
		}
	}

	if (!data) {
		throw new Error(
			`None of the ${RELEASES_LIMIT} last releases contain a package with "${archiveSuffix}" suffix.`
		);
	}

	stage(`cleanup`);
	log(`Cleaning up old files.`);
	await cleanup(dataPath);

	stage('downloading');
	log(`URL: "${data.url}"`);
	log(` TO: "${tmpPath}"`);

	const filename = await download(data.url, tmpPath, {onProgress: progress});

	progress(null);
	const archivePath = Path.join(tmpPath, filename);

	stage('extracting');
	log(`ARCHIVE: "${archivePath}"`);
	const extractedFiles = await extract(archivePath, {listDetails: true, onProgress: progress});
	progress(null);
	const firstFile = extractedFiles[0];

	if (extractedFiles.length !== 1 || !firstFile || !firstFile.isDirectory) {
		if (extractedFiles.length === 0) throw new Error(`Extracted archive files list is empty.`);
		else
			throw new Error(
				`Unexpected archive structure:\n${extractedFiles.map(({path}) => Path.basename(path)).join('\n')}`
			);
	}

	stage(`moving files`);
	log(`FROM: ${firstFile.path}`);
	log(`  TO: ${dataPath}`);

	for (const file of await FSP.readdir(firstFile.path, {withFileTypes: true})) {
		const fromPath = Path.join(firstFile.path, file.name);
		const toPath = Path.join(dataPath, file.name);
		log(`→ ${file.isDirectory() ? ' [dir]' : '[file]'}: ${file.name}`);
		await FSP.rename(fromPath, toPath);
	}

	/**
	 * We need to write down the version manually, because the binary has no
	 * API to describe itself.
	 */
	stage(`versioning`);
	log(`Creating version file "${VERSION_FILE}" containing release version "${data.version}".`);

	await FSP.writeFile(Path.join(dataPath, VERSION_FILE), data.version);

	log(`Done. Dependency should be installed.`);
}

// Expected options object
export type Options = SaveAsOptions & {
	format: 'jpg' | 'png' | 'webp';
	scale: string;
	denoise: string;
	model: 'models-cunet' | 'models-upconv_7_anime_style_art_rgb' | 'models-upconv_7_photo';
	tta: boolean;
	tileSize: string;
	gpuId: string;
	loadProcSave: string;
	video: {
		inheritContainer: boolean;
		preferredContainer: 'mp4' | 'webm' | 'mkv';
		keepSubtitles: boolean; // if there are subs, forces container to be mkv

		mp4Codec: 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1';
		webmCodec: 'vp8' | 'vp9' | 'av1';
		mkvCodec: 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1';

		h264: {
			crf: number; // 0: lossless, 51: worst
			preset:
				| 'ultrafast'
				| 'superfast'
				| 'veryfast'
				| 'faster'
				| 'fast'
				| 'medium'
				| 'slow'
				| 'slower'
				| 'veryslow';
			tune: '' | 'film' | 'animation' | 'grain' | 'stillimage' | 'fastdecode' | 'zerolatency';
			profile: 'auto' | 'baseline' | 'main' | 'high';
		};

		h265: {
			crf: number; // 0: lossless, 51: worst
			preset:
				| 'ultrafast'
				| 'superfast'
				| 'veryfast'
				| 'faster'
				| 'fast'
				| 'medium'
				| 'slow'
				| 'slower'
				| 'veryslow';
			tune: '' | 'grain' | 'zerolatency' | 'fastdecode';
			// prettier-ignore
			profile: 'auto' | 'main' | 'main-intra' | 'mainstillpicture' | 'main444-8' | 'main444-intra' | 'main444-stillpicture' | 'main10' | 'main10-intra' | 'main422-10' | 'main422-10-intra' | 'main444-10' | 'main444-10-intra' | 'main12' | 'main12-intra' | 'main422-12' | 'main422-12-intra' | 'main444-12' | 'main444-12-intra';
		};

		vp8: {
			crf: number; // 0: lossless, 63: worst
			qmin: number; // 0-63
			qmax: number; // qmin-63
			speed: number; // 0: slowest/best quality, 5: fastest/worst quality
			twoPass: boolean;
		};

		vp9: {
			mode: 'quality' | 'constrained-quality' | 'bitrate' | 'lossless' | 'size';
			crf: number; // 0: lossless, 63: worst
			qmin: number; // 0-63
			qmax: number; // qmin-63
			bitrate: number; // KB per second per million pixels (bitrate mode)
			minrate: number; // KB per second per million pixels (bitrate mode)
			maxrate: number; // KB per second per million pixels (bitrate mode)
			size: number; // target size in Mpx
			twoPass: boolean;
			speed: number; // 0: slowest/best quality, 5: fastest/worst quality
			threads: number;
		};

		av1: {
			mode: 'quality' | 'constrained-quality' | 'bitrate' | 'size';
			crf: number; // 0: lossless, 63: worst
			qmin: number; // 0-63
			qmax: number; // qmin-63
			bitrate: number; // KB per second per million pixels (bitrate mode)
			minrate: number; // KB per second per million pixels (bitrate mode)
			maxrate: number; // KB per second per million pixels (bitrate mode)
			size: number; // target size in Mpx
			maxKeyframeInterval: number;
			twoPass: boolean;
			speed: number; // 0: slowest/best quality, 8: fastest/worst quality
			multithreading: boolean;
		};

		gif: {
			colors: number;
			dithering: 'none' | 'bayer' | 'sierra2_4a';
		};

		audioChannelBitrate: number;
		pixelFormat: string;
	};
};

// Options schema for the Options type above
const optionsSchema: OptionsSchema<Options> = [
	makeOptionSchema(),
	{
		name: 'scale',
		type: 'select',
		default: '2',
		options: {'1': '1x', '2': '2x', '4': '4x', '8': '8x', '16': '16x', '32': '32x'},
		title: 'Scale',
		description: `Upscale level.`,
	},
	{
		name: 'denoise',
		type: 'select',
		options: ['-1', '0', '1', '2', '3'],
		default: '1',
		title: 'Denoise',
		description: `Large value means strong denoise effect, -1 = no effect.`,
	},
	{
		name: 'model',
		type: 'select',
		options: {
			'models-cunet': 'cunet',
			'models-upconv_7_anime_style_art_rgb': 'art',
			'models-upconv_7_photo': 'photo',
		},
		default: 'models-cunet',
		title: 'Model',
		description: `Waifu2x training model. <b>photo</b> retains textures &amp; grain, <b>art</b> smooths them out, and <b>cunet</b> is somewhere in the middle`,
	},
	{
		name: 'format',
		type: 'select',
		options: ['jpg', 'png', 'webp'],
		default: 'png',
		title: 'Output format',
		description: `PNG and webp are lossless. PNG has better support, webp is a bit smaller.`,
	},
	{type: 'divider', title: 'Advanced'},
	{
		name: 'tta',
		type: 'boolean',
		default: false,
		title: 'TTA mode',
		description: `Test-time augmentation mode averages the upscaling results of 8 augmented inputs. It's able to reduce several types of artifacts at the cost of being 8x slower.`,
	},
	{
		name: 'tileSize',
		type: 'string',
		default: '0',
		cols: 10,
		title: 'Tile size',
		description: `Use smaller value to reduce GPU memory usage, default (<code>0</code>) selects automatically. Has to be <code>&gt;=32</code> or <code>0</code>. Can be <code>0,0,0</code> for multi-gpu.`,
	},
	{
		name: 'gpuId',
		type: 'string',
		default: 'auto',
		cols: 10,
		title: 'GPU ID',
		description: `GPU device to use. <code>-1</code> for CPU, <code>auto</code> for auto. Can be <code>0,1,2</code> for multi-gpu.`,
	},
	{
		name: 'loadProcSave',
		type: 'string',
		default: '1:2:2',
		cols: 16,
		title: 'Thread count',
		description: `Thread count for load:proc:save. Default is <code>1:2:2</code>. Can be <code>1:2,2,2:2</code> for multi-gpu.`,
	},
];

// Accept everything! Read documentation on how to fine tune.
const acceptsFlags = makeAcceptsFlags<Options>()({
	files: true,
});

// The final payload type based on options and accept flags defined above.
// Needs to be exported so that it can be used by the processor.
export type Payload = PayloadData<Options, typeof acceptsFlags>;

export default (plugin: Plugin) => {
	plugin.registerDependency('waifu2x', {
		load: loadDependency,
		install: installDependency,
	});

	plugin.registerProcessor<Payload>('upscale', {
		main: 'dist/processor.js',
		description: 'Upscale images using waifu2x.',
		dependencies: ['waifu2x', '@drovp/ffmpeg:ffmpeg', '@drovp/ffmpeg:ffprobe'],
		accepts: acceptsFlags,
		threadType: ['cpu', 'gpu'],
		options: optionsSchema,
	});
};

/// @ts-ignore
window.test = async () => {
	const inputDir = Path.normalize(`F:/Downloads/in`);
	const args: string[] = ['-y'];

	// Input
	args.push('-re');
	args.push('-framerate', '6');
	args.push('-f', 'image2pipe');
	args.push('-i', 'pipe:0');

	// Audio
	// args.push('-i', Path.join(inputDir, 'a.webm'));

	// Sort streams
	// args.push('-map', '0:v:0');
	// args.push('-map', '1:a?');
	// args.push('-map', '1:s?');
	// args.push('-map', '1:t?');

	// Output

	/*
	// GIF
	// prettier-ignore
	args.push('-vf', [
		`split[o1][o2]`,
		`[o1]palettegen=max_colors=256[p]`,
		`[o2]fifo[o3]`,
		`[o3][p]paletteuse=dither=none`, // none, bayer, sierra2
	].join(';'));
	args.push('out.gif');
	*/

	args.push('out.mp4');

	console.log(args.join(' '));

	const cp = CP.spawn('E:/utils/ffmpeg', args, {cwd: inputDir});
	cp.stdout.on('data', (data: Buffer) => {
		console.log('stdout:', data.toString());
	});
	cp.stderr.on('data', (data: Buffer) => {
		console.log('stderr:', data.toString());
	});

	let done = (err?: Error | null, code?: number | null) => {
		done = () => {};
		if (err) {
			console.error(err);
		} else if (code != null && code > 0) {
			console.error(new Error(`Process exited with code ${code}.`));
		} else {
			console.log('DONE');
		}
	};

	cp.on('error', (err) => done(err));
	cp.on('close', (code) => done(null, code));

	// const frames = ['i-0.png', 'i-1.png', 'i-2.png', 'i-3.png'];
	const frames = ['i-0.jpg', 'i-1.jpg', 'i-2.jpg', 'i-3.jpg'];

	for (const frame of frames) {
		const path = Path.join(inputDir, frame);
		cp.stdin.write(await FSP.readFile(path));
		console.log('frame');
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}

	cp.stdin.end();
};
