import * as Path from 'path';
import {spawn} from 'child_process';
import type {ProcessorUtils} from '@drovp/types';
import type {Payload} from './';
import {checkSaveAsPathOptions, TemplateError, saveAsPath} from '@drovp/save-as-path';

// Potential processor dependency payloads must be defined manually
interface Dependencies {
	waifu2x: string;
}

export default async (payload: Payload, utils: ProcessorUtils<Dependencies>) => {
	const {input, options} = payload;
	const {dependencies, output, log} = utils;
	const dirname = Path.dirname(input.path);
	const filename = Path.basename(input.path, Path.extname(input.path));
	const tmpPath = Path.join(dirname, `${filename}-tmp${Math.random().toString().slice(-6)}.${options.format}`);
	const args: (string | number)[] = [];

	// First, we check that options have a valid template.
	try {
		checkSaveAsPathOptions(options.saving);
	} catch (error) {
		if (error instanceof TemplateError) {
			output.error(`Destination template error: ${error.message}`);
			return;
		}
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
	args.push('-f', options.format);
	args.push('-i', input.path);
	args.push('-o', tmpPath);

	await waifu2x(dependencies.waifu2x, args, {cwd: dirname, onLog: log});

	// Save as path
	const outputPath = await saveAsPath(input.path, tmpPath, options.format, options.saving);

	// We emit a new file
	utils.output.file(outputPath);
};

function waifu2x(
	binPath: string = 'waifu2x',
	args: (string | number)[],
	{onLog, cwd}: {onLog?: (message: string) => void; cwd?: string} = {}
) {
	return new Promise<void>((resolve, reject) => {
		const finalArgs = args.map(toString);

		onLog?.(`Executing waifu2x:
----------------------------------------
→ bin: "${binPath}"
→ params: ${finalArgs.map(argToParam).join(' ')}
----------------------------------------`);

		const cp = spawn(binPath, finalArgs, {cwd});
		let stdout = '';
		let stderr = '';

		cp.stdout.on('data', (data: Buffer) => {
			const message = data.toString();
			stdout += message;
			onLog?.(message);
		});
		cp.stderr.on('data', (data: Buffer) => {
			const message = data.toString();
			stderr += message;
			onLog?.(message);
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
