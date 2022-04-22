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
type Options = SaveAsOptions & {
	format: 'jpg' | 'png' | 'webp';
	scale: string;
	denoise: string;
	model: 'models-cunet' | 'models-upconv_7_anime_style_art_rgb' | 'models-upconv_7_photo';
	tta: boolean;
	tileSize: string;
	gpuId: string;
	loadProcSave: string;
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
	files: ['jpg', 'png', 'webp'],
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
		dependencies: ['waifu2x'],
		accepts: acceptsFlags,
		threadType: ['cpu', 'gpu'],
		options: optionsSchema,
	});
};
