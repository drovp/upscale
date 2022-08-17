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
import {makeOptionSchema as makeSavingOptionSchema, Options as SaveAsOptions} from '@drovp/save-as-path';

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
	scale: string;
	denoise: string;
	model: 'models-cunet' | 'models-upconv_7_anime_style_art_rgb' | 'models-upconv_7_photo';
	tta: boolean;
	tileSize: string;
	gpuId: string;
	loadProcSave: string;
	image: {
		format: 'jpg' | 'png' | 'webp';
		jpg: {
			quality: number; // 1: best, 31: worst
			background: string;
		};
		webp: {
			quality: number; // 0: worst, 100: best
			preset: 'none' | 'default' | 'picture' | 'photo' | 'drawing' | 'icon' | 'text';
		};
	};
	video: {
		inheritContainer: boolean;
		preferredContainer: 'mp4' | 'webm' | 'mkv';
		ensureSubtitles: boolean; // if there are subs, forces container to be mkv

		mp4Codec: 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1';
		webmCodec: 'vp8' | 'vp9' | 'av1';
		mkvCodec: 'h264' | 'h265' | 'vp8' | 'vp9' | 'av1';

		codecCategory?: string; // Decorative

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
			crf: number; // 0: lossless, 63: worst
			qmin: number; // 0-63
			qmax: number; // qmin-63
			twoPass: boolean;
			speed: number; // 0: slowest/best quality, 5: fastest/worst quality
			threads: number;
		};

		av1: {
			crf: number; // 0: lossless, 63: worst
			qmin: number; // 0-63
			qmax: number; // qmin-63
			maxKeyframeInterval: number;
			twoPass: boolean;
			speed: number; // 0: slowest/best quality, 8: fastest/worst quality
			multithreading: boolean;
		};

		gif: {
			colors: number;
			dithering: 'none' | 'bayer' | 'sierra2_4a';
		};

		audioCodec: 'libopus' | 'libvorbis';
		audioChannelBitrate: number;
		pixelFormat: string;
	};
};

// Options schema for the Options type above
const optionsSchema: OptionsSchema<Options> = [
	makeSavingOptionSchema(),
	{
		name: 'scale',
		type: 'select',
		default: '2',
		options: {'2': '2x', '4': '4x', '8': '8x', '16': '16x', '32': '32x'},
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
		name: 'image',
		type: 'namespace',
		title: 'Image',
		description: `Input can be any image supported by ffmpeg.`,
		schema: [
			{
				name: 'format',
				type: 'select',
				options: {jpg: 'JPG', png: 'PNG', webp: 'WEBP'},
				default: 'png',
				title: 'Output format',
				description: `PNG is lossless, JPG doesn't support alpha channel, and WEBP has the best compression ratio but lowest support.`,
			},
			{
				name: 'jpg',
				type: 'namespace',
				isHidden: (_, {image}) => image.format !== 'jpg',
				schema: [
					{
						name: 'quality',
						type: 'number',
						min: 1,
						max: 31,
						step: 1,
						default: 3,
						title: 'Quality',
						description: `FFmpeg's <code>jpg</code> encoder quality. 1 = best, biggest file; 31 = worst, smallest file.`,
					},
					{
						name: 'background',
						type: 'color',
						default: 'white',
						title: 'Background',
						description: `Background color to use when converting from images with transparent background.<br>Format: <code>#RRGGBB</code>, or name of the color as defined <a href="https://ffmpeg.org/ffmpeg-utils.html#Color">here</a>.`,
					},
				],
			},
			{
				name: 'webp',
				type: 'namespace',
				isHidden: (_, {image}) => image.format !== 'webp',
				schema: [
					{
						name: 'quality',
						type: 'number',
						min: 1,
						max: 100,
						step: 1,
						default: 80,
						title: 'Quality',
						description: `<code>libwebp</code> encoder quality. 1 = worst, smallest file; 100 = best, biggest file.`,
					},
					{
						name: 'preset',
						type: 'select',
						options: ['none', 'default', 'picture', 'photo', 'drawing', 'icon', 'text'],
						default: 'picture',
						title: 'Preset',
					},
				],
			},
		],
	},
	{
		name: 'video',
		type: 'namespace',
		title: 'Video',
		description: `Input can be anything FFmpeg accepts, supported output containers are <code>mp4</code>, <code>webm</code>, <code>mkv</code>, <code>gif</code>. Careful, upscaling video means saving all of its frames into lossless png files, upscaling them, and re-encoding back to a new video, which can take a considerable amount of space and time.`,
		schema: [
			{
				name: 'inheritContainer',
				type: 'boolean',
				default: true,
				title: 'Inherit container',
				description: `Will try to output video into the same container type as input (mp4 -> mp4) if it's one of the supported output containers.<br>If not supported, or this option is disabled, the <b>Preferred container</b> below will be used.`,
			},
			{
				name: 'preferredContainer',
				type: 'select',
				default: 'mp4',
				options: ['mp4', 'webm', 'mkv'],
				title: 'Preferred container',
				description: `What container to default to if input doesn't match one of the supported output containers, or if <b>Inherit container</b> option is disabled.`,
			},
			{
				name: 'ensureSubtitles',
				type: 'boolean',
				default: true,
				title: 'Ensure subtitles',
				description: `If input contains subtitles stream(s), force output container to <code>mkv</code> (the only one that supports subtitles streams), regardless of the options above.`,
			},
			{
				name: 'mp4Codec',
				type: 'select',
				default: 'h264',
				options: ['h264', 'h265', 'vp8', 'vp9', 'av1'],
				title: 'MP4 Codec',
				description: `What video codec to use when encoding into mp4 container.`,
			},
			{
				name: 'webmCodec',
				type: 'select',
				default: 'vp8',
				options: ['vp8', 'vp9', 'av1'],
				title: 'WEBM Codec',
				description: `What video codec to use when encoding into webm container.`,
			},
			{
				name: 'mkvCodec',
				type: 'select',
				default: 'h264',
				options: ['h264', 'h265', 'vp8', 'vp9', 'av1'],
				title: 'MKV Codec',
				description: `What video codec to use when encoding into mkv container.`,
			},
			{
				name: 'codecCategory',
				type: 'category',
				options: ({video}) => {
					const usedCodecsSet = new Set<string>([video.mp4Codec, video.webmCodec, video.mkvCodec]);
					return [
						...['h264', 'h265', 'vp8', 'vp9', 'av1'].filter((codec) => usedCodecsSet.has(codec)),
						'gif',
					];
				},
				default: 'h264',
			},
			{
				name: 'h264',
				type: 'namespace',
				isHidden: (_, {video}) => video.codecCategory !== 'h264',
				schema: [
					{
						name: 'crf',
						type: 'number',
						min: 0,
						max: 51,
						step: 1,
						default: 23,
						title: 'CRF',
						description: `Constant quality rate factor. 0 = lossless, biggest file; 51 = worst, smallest file.<br>Subjectively sane range is 17-28. Consider 17-18 to be visually lossless.`,
					},
					{
						name: 'preset',
						type: 'select',
						// prettier-ignore
						options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
						default: 'medium',
						title: 'Preset',
						description: `Slower presets will produce smaller files.`,
					},
					{
						name: 'tune',
						type: 'select',
						// prettier-ignore
						options: ['', 'film', 'animation', 'grain', 'stillimage', 'fastdecode', 'zerolatency'],
						default: '',
						title: 'Tune',
						description: (_, {video}) =>
							`Changes encoding settings based upon the specifics of your input.<br>
<b>film</b> - use for high quality movie content; lowers deblocking</br>
<b>animation</b> – good for cartoons; uses higher deblocking and more reference frames</br>
<b>grain</b> – preserves the grain structure in old, grainy film material</br>
<b>stillimage</b> – good for slideshow-like content</br>
<b>fastdecode</b> – allows faster decoding by disabling certain filters</br>
<b>zerolatency</b> – good for fast encoding and low-latency streaming</br>`,
					},
					{
						name: 'profile',
						type: 'select',
						options: ['auto', 'baseline', 'main', 'high'],
						default: 'auto',
						title: 'Profile',
						description: `
<b>auto</b> (recommended) - This will automatically set the profile based on all the options that have been selected.<br>
<b>baseline</b> - The most basic form of encoding. Decoding is easier, but it requires higher bit-rates to maintain the same quality.<br>
<b>main</b> - The middle ground. Most modern / current devices will support this profile.<br>
<b>high</b> - For best quality and filesize at the expense of CPU time in both decode and encode.`,
					},
				],
			},
			{
				name: 'h265',
				type: 'namespace',
				isHidden: (_, {video}) => video.codecCategory !== 'h265',
				schema: [
					{
						name: 'crf',
						type: 'number',
						min: 0,
						max: 51,
						step: 1,
						default: 28,
						title: 'CRF',
						description: `Constant quality rate factor. 0 = lossless, biggest file; 51 = worst, smallest file. 28 is equivalent to H.264's 23.`,
					},
					{
						name: 'preset',
						type: 'select',
						// prettier-ignore
						options: ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
						default: 'medium',
						title: 'Preset',
						description: `Slower presets will produce smaller files.`,
					},
					{
						name: 'tune',
						type: 'select',
						options: ['', 'grain', 'zerolatency', 'fastdecode'],
						default: '',
						title: 'Tune',
						description: `Changes encoding settings based upon the specifics of your input.<br>
<b>grain</b> – preserves the grain structure in old, grainy film material</br>
<b>fastdecode</b> – allows faster decoding by disabling certain filters</br>
<b>zerolatency</b> – good for fast encoding and low-latency streaming</br>`,
					},
					{
						name: 'profile',
						type: 'select',
						// prettier-ignore
						options: [
							'auto', 'main', 'main-intra', 'mainstillpicture', 'main444-8', 'main444-intra', 'main444-stillpicture',
							'main10', 'main10-intra', 'main422-10', 'main422-10-intra', 'main444-10', 'main444-10-intra', 'main12',
							'main12-intra', 'main422-12', 'main422-12-intra', 'main444-12', 'main444-12-intra'
						],
						default: 'auto',
						title: 'Profile',
						description: `<b>auto</b> (recommended) will automatically set the profile based on all the options that have been selected.`,
					},
				],
			},
			{
				name: 'vp8',
				type: 'namespace',
				isHidden: (_, {video}) => video.codecCategory !== 'vp8',
				schema: [
					{
						name: 'crf',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 10,
						title: 'CRF',
						description: `Constant quality rate factor. 0 = lossless, biggest file; 63 = worst, smallest file. Value has to be between <code>qmin</code> and <code>qmax</code> below.`,
					},
					{
						name: 'qmin',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 4,
						title: 'qmin',
						description: `The minimum range of quantizers that the rate control algorithm may use.`,
					},
					{
						name: 'qmax',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 20,
						title: 'qmax',
						description: `The maximum range of quantizers that the rate control algorithm may use.`,
					},
					{
						name: 'twoPass',
						type: 'boolean',
						default: true,
						title: '2 pass',
						description: `Encodes video in 2 passes, 1st one to prepare a lookahead information so that the actual 2nd encode can do its job better. This takes longer than a simple 1 pass encode.<br>It is highly recommended to use 2 pass encoding in bitrate, and especially in size rate control mode.<br>
						2 pass is also useful in CRF mode, as lbvpx disables some useful encoding features when doing only 1 pass.`,
					},
					{
						name: 'speed',
						type: 'number',
						min: 0,
						max: 5,
						step: 1,
						default: 1,
						title: 'Speed',
						description: `Set quality/speed ratio modifier. Higher values speed up the encode at the cost of quality.`,
					},
				],
			},
			{
				name: 'vp9',
				type: 'namespace',
				isHidden: (_, {video}) => video.codecCategory !== 'vp9',
				schema: [
					{
						name: 'crf',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 30,
						title: 'CRF',
						description: `Constant quality rate factor. 0 = lossless, biggest file; 63 = worst, smallest file. Value has to be between <code>qmin</code> and <code>qmax</code> below.`,
					},
					{
						name: 'qmin',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 4,
						title: 'qmin',
						description: `The minimum range of quantizers that the rate control algorithm may use.`,
					},
					{
						name: 'qmax',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 40,
						title: 'qmax',
						description: `The maximum range of quantizers that the rate control algorithm may use.`,
					},
					{
						name: 'twoPass',
						type: 'boolean',
						default: true,
						title: '2 pass',
						description: `Encodes video in 2 passes, 1st one to prepare a lookahead information so that the actual 2nd encode can do its job better. This takes longer than a simple 1 pass encode.<br>It is highly recommended to use 2 pass encoding in bitrate, and especially in size rate control mode.<br>
						This is also useful in quality mode, as some quality-enhancing encoder features are only available in 2-pass mode.`,
					},
					{
						name: 'speed',
						type: 'number',
						min: 0,
						max: 5,
						step: 1,
						default: 0,
						title: 'Speed',
						description: `Set quality/speed ratio modifier. Using 1 or 2 will increase encoding speed at the expense of having some impact on quality and rate control accuracy. 4 or 5 will turn off rate distortion optimization, having even more of an impact on quality.`,
					},
					{
						name: 'threads',
						type: 'number',
						steps: [1, 2, 4, 8, 16, 32],
						default: 0,
						title: 'Threads',
						hint: (value) => value,
						description: `Splits the video into rectangular regions, and encodes each in its own thread.`,
					},
				],
			},
			{
				name: 'av1',
				type: 'namespace',
				isHidden: (_, {video}) => video.codecCategory !== 'av1',
				schema: [
					{
						name: 'crf',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 30,
						title: 'CRF',
						description: `Constant quality rate factor. 0 = lossless, biggest file; 63 = worst, smallest file. Value has to be between <code>qmin</code> and <code>qmax</code> below.`,
					},
					{
						name: 'qmin',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 0,
						title: 'qmin',
						description: `The minimum range of quantizers that the rate control algorithm may use.`,
					},
					{
						name: 'qmax',
						type: 'number',
						min: 0,
						max: 63,
						step: 1,
						default: 63,
						title: 'qmax',
						description: `The maximum range of quantizers that the rate control algorithm may use.`,
					},
					{
						name: 'maxKeyframeInterval',
						type: 'number',
						kind: 'float',
						min: 0,
						max: 10,
						softMax: true,
						step: 0.1,
						default: 10,
						title: 'Max keyframe interval',
						hint: `s`,
						description: `Set the maximum keyframe interval in seconds. Setting to 0 will use the default keyframe interval of 9999 frames, which can lead to slow seeking.`,
					},
					{
						name: 'twoPass',
						type: 'boolean',
						default: true,
						title: '2 pass',
						description: `Encodes video in 2 passes, 1st one to prepare a lookahead information so that the actual 2nd encode can do its job better. This takes longer than a simple 1 pass encode.`,
					},
					{
						name: 'speed',
						type: 'number',
						min: 0,
						max: 8,
						step: 1,
						default: 1,
						title: 'Speed',
						description: `Sets how efficient the compression will be. Lower values mean slower encoding with better quality, and vice-versa.`,
					},
					{
						name: 'multithreading',
						type: 'boolean',
						default: true,
						title: 'Multithreading',
						description: `Enables row-based multi-threading which maximizes CPU usage.`,
					},
				],
			},
			{
				name: 'gif',
				type: 'namespace',
				isHidden: (_, {video}) => video.codecCategory !== 'gif',
				schema: [
					{
						name: 'colors',
						type: 'number',
						min: 4,
						max: 256,
						step: 1,
						default: 256,
						title: 'Colors',
						description: `Limit the max number of colors to use in the palette. Lower number produces smaller files at the cost of quality.`,
					},
					{
						name: 'dithering',
						type: 'select',
						default: 'bayer',
						options: ['none', 'bayer', 'sierra2'],
						title: 'Dithering',
						description: `
						<b>none</b> - smallest file size, more color banding<br>
						<b>bayer</b> - middle ground<br>
						<b>sierra2</b> - best perceived results, largest file size<br>
						`,
					},
				],
			},
			{
				name: 'pixelFormat',
				type: 'select',
				// prettier-ignore
				options: [
					'yuv420p', 'yuyv422', 'rgb24', 'bgr24', 'yuv422p', 'yuv444p', 'yuv410p', 'yuv411p', 'gray', 'monow',
					'monob', 'pal8', 'yuvj420p', 'yuvj422p', 'yuvj444p', 'uyvy422', 'uyyvyy411', 'bgr8', 'bgr4',
					'bgr4_byte', 'rgb8', 'rgb4', 'rgb4_byte', 'nv12', 'nv21', 'argb', 'rgba', 'abgr', 'bgra',
					'gray16be', 'gray16le', 'yuv440p', 'yuvj440p', 'yuva420p', 'rgb48be', 'rgb48le', 'rgb565be',
					'rgb565le', 'rgb555be', 'rgb555le', 'bgr565be', 'bgr565le', 'bgr555be', 'bgr555le', 'vaapi_moco',
					'vaapi_idct', 'vaapi_vld', 'yuv420p16le', 'yuv420p16be', 'yuv422p16le', 'yuv422p16be',
					'yuv444p16le', 'yuv444p16be', 'dxva2_vld', 'rgb444le', 'rgb444be', 'bgr444le', 'bgr444be', 'ya8',
					'bgr48be', 'bgr48le', 'yuv420p9be', 'yuv420p9le', 'yuv420p10be', 'yuv420p10le', 'yuv422p10be',
					'yuv422p10le', 'yuv444p9be', 'yuv444p9le', 'yuv444p10be', 'yuv444p10le', 'yuv422p9be', 'yuv422p9le',
					'gbrp', 'gbrp9be', 'gbrp9le', 'gbrp10be', 'gbrp10le', 'gbrp16be', 'gbrp16le', 'yuva422p',
					'yuva444p', 'yuva420p9be', 'yuva420p9le', 'yuva422p9be', 'yuva422p9le', 'yuva444p9be',
					'yuva444p9le', 'yuva420p10be', 'yuva420p10le', 'yuva422p10be', 'yuva422p10le', 'yuva444p10be',
					'yuva444p10le', 'yuva420p16be', 'yuva420p16le', 'yuva422p16be', 'yuva422p16le', 'yuva444p16be',
					'yuva444p16le', 'vdpau', 'xyz12le', 'xyz12be', 'nv16', 'nv20le', 'nv20be', 'rgba64be', 'rgba64le',
					'bgra64be', 'bgra64le', 'yvyu422', 'ya16be', 'ya16le', 'gbrap', 'gbrap16be', 'gbrap16le', 'qsv',
					'mmal', 'd3d11va_vld', 'cuda', '0rgb', 'rgb0', '0bgr', 'bgr0', 'yuv420p12be', 'yuv420p12le',
					'yuv420p14be', 'yuv420p14le', 'yuv422p12be', 'yuv422p12le', 'yuv422p14be', 'yuv422p14le',
					'yuv444p12be', 'yuv444p12le', 'yuv444p14be', 'yuv444p14le', 'gbrp12be', 'gbrp12le', 'gbrp14be',
					'gbrp14le', 'yuvj411p', 'bayer_bggr8', 'bayer_rggb8', 'bayer_gbrg8', 'bayer_grbg8',
					'bayer_bggr16le', 'bayer_bggr16be', 'bayer_rggb16le', 'bayer_rggb16be', 'bayer_gbrg16le',
					'bayer_gbrg16be', 'bayer_grbg16le', 'bayer_grbg16be', 'xvmc', 'yuv440p10le', 'yuv440p10be',
					'yuv440p12le', 'yuv440p12be', 'ayuv64le', 'ayuv64be', 'videotoolbox_vld', 'p010le', 'p010be',
					'gbrap12be', 'gbrap12le', 'gbrap10be', 'gbrap10le', 'mediacodec', 'gray12be', 'gray12le',
					'gray10be', 'gray10le', 'p016le', 'p016be', 'd3d11', 'gray9be', 'gray9le', 'gbrpf32be', 'gbrpf32le',
					'gbrapf32be', 'gbrapf32le', 'drm_prime', 'opencl', 'gray14be', 'gray14le', 'grayf32be', 'grayf32le',
					'yuva422p12be', 'yuva422p12le', 'yuva444p12be', 'yuva444p12le', 'nv24', 'nv42', 'vulkan', 'y210be',
					'y210le', 'x2rgb10le', 'x2rgb10be',
				],
				default: 'yuv420p',
				title: 'Pixel format',
				isHidden: (_, {video}) => video.codecCategory === 'gif',
			},
			{
				type: 'divider',
				title: 'Audio',
				description: `Audio streams are always copied without re-encoding when output container matches the input. Otherwise they are re-encoded based on options below.`,
			},
			{
				name: 'audioCodec',
				type: 'select',
				options: {libopus: 'Opus', libvorbis: 'Vorbis'},
				default: 'libopus',
				title: 'Audio codec',
				description: `Opus is better, but Vorbis is older with slightly better support.`,
			},
			{
				name: 'audioChannelBitrate',
				type: 'number',
				min: 16,
				max: 160,
				step: 16,
				softMax: true,
				default: 64,
				title: 'Audio bitrate per channel',
				hint: 'Kb/ch/s',
				description: `Set the desired average <b>opus</b> audio bitrate <b>PER CHANNEL</b> per second.<br>For example, if you want a standard stereo (2 channels) audio to have a <code>96Kbps</code> bitrate, set this to <code>48</code>.`,
			},
		],
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
	// prettier-ignore
	files: [
		'3ds', '3g2', '3gp', '3gpp', 'apng', 'asf', 'asx', 'avci', 'avcs', 'avi', 'avif', 'azv', 'b16', 'bmp', 'bmp', 'btif', 'cgm', 'cmx', 'dds', 'djv', 'djvu', 'drle', 'dvb', 'dwg', 'dxf', 'emf', 'exr', 'f4v', 'fbs', 'fh', 'fh4', 'fh5', 'fh7', 'fhc', 'fits', 'fli', 'flv', 'fpx', 'fst', 'fvt', 'g3', 'gif', 'h261', 'h263', 'h264', 'heic', 'heics', 'heif', 'heifs', 'hej2', 'hsj2', 'ico', 'ico', 'ief', 'jhc', 'jls', 'jng', 'jp2', 'jpe', 'jpeg', 'jpf', 'jpg', 'jpg2', 'jpgm', 'jpgv', 'jph', 'jpm', 'jpm', 'jpx', 'jxl', 'jxr', 'jxra', 'jxrs', 'jxs', 'jxsc', 'jxsi', 'jxss', 'ktx', 'ktx2', 'm1v', 'm2v', 'm4s', 'm4u', 'm4v', 'mdi', 'mj2', 'mjp2', 'mk3d', 'mks', 'mkv', 'mmr', 'mng', 'mov', 'movie', 'mp4', 'mp4v', 'mpe', 'mpeg', 'mpg', 'mpg4', 'mxu', 'npx', 'ogv', 'pbm', 'pct', 'pcx', 'pcx', 'pgm', 'pic', 'png', 'pnm', 'ppm', 'psd', 'pti', 'pyv', 'qt', 'ras', 'rgb', 'rlc', 'sgi', 'sid', 'smv', 'sub', 'svg', 'svgz', 't38', 'tap', 'tfx', 'tga', 'tif', 'tiff', 'ts', 'uvg', 'uvh', 'uvi', 'uvm', 'uvp', 'uvs', 'uvu', 'uvv', 'uvvg', 'uvvh', 'uvvi', 'uvvm', 'uvvp', 'uvvs', 'uvvu', 'uvvv', 'viv', 'vob', 'vtf', 'wbmp', 'wdp', 'webm', 'webp', 'wm', 'wmf', 'wmv', 'wmx', 'wvx', 'xbm', 'xif', 'xpm', 'xwd'
	],
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
		description: 'Upscale images and videos using waifu2x.',
		dependencies: ['waifu2x', '@drovp/ffmpeg:ffmpeg', '@drovp/ffmpeg:ffprobe'],
		accepts: acceptsFlags,
		threadType: ['cpu', 'gpu'],
		options: optionsSchema,
	});
};
