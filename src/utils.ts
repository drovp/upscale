import {promises as FSP} from 'fs';
import * as Path from 'path';
import * as CP from 'child_process';
import type {Progress} from '@drovp/types';

/**
 * Extract error message.
 */
export function eem(value: any, preferStack?: boolean) {
	return value instanceof Error ? (preferStack ? value.stack || value.message : value.message) : `${value}`;
}

/**
 * Converts CLI arguments array into a string as it'd be seen when used in a console.
 */
export function argsToString(args: (string | number)[]) {
	return args
		.map((arg) => {
			const value = `${arg}`;
			return value[0] === '-' ? value : value.match(/[^a-zA-Z0-9\-_]/) ? `"${value}"` : value;
		})
		.join(' ');
}

export const getFilename = (path: string) => Path.basename(path, Path.extname(path));

export function getExtension(path: string) {
	const extname = Path.extname(path).trim().slice(1).toLocaleLowerCase();
	return extname === 'jpeg' ? 'jpg' : extname;
}

/**
 * '1:30:40.500' => {milliseconds}
 */
export function isoTimeToMS(text: string) {
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

/**
 * Deletes anything on the passed path and creates and empty directory in its place.
 */
export async function prepareEmptyDir(path: string) {
	await deletePath(path);
	await FSP.mkdir(path, {recursive: true});
}

export const deletePath = (path: string) => FSP.rm(path, {recursive: true, force: true});

/**
 * Periodically cleans files from source directory that have been cloned into
 * destination, and reports the progress. Works by polling.
 * Checks only file names, ignores extensions.
 */
export function makeDirCloneCleaner(
	sourceDir: string,
	destinationDir: string,
	{onProgress, interval = 2000}: {onProgress: (completed: number, total: number) => void; interval?: number}
) {
	/** Map of `filename: extension` pairs. */
	let sourceFiles: Map<string, string> | null = null;
	const cloned = new Set<string>();
	let isDisposed = false;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	async function loop() {
		if (isDisposed) return;

		if (sourceFiles == null) {
			sourceFiles = new Map();
			for (const file of await FSP.readdir(sourceDir)) {
				const extension = Path.extname(file);
				const name = Path.basename(file, extension);
				sourceFiles.set(name, extension);
			}
		}

		const newClonedFilenames: string[] = [];

		for (const file of await FSP.readdir(destinationDir)) {
			const filename = getFilename(file);
			if (cloned.has(filename)) continue;
			newClonedFilenames.push(filename);
			cloned.add(filename);
		}

		for (const filename of newClonedFilenames) {
			if (isDisposed) break;
			const extension = sourceFiles.get(filename);
			await deletePath(Path.join(sourceDir, `${filename}${extension}`));
		}

		onProgress(cloned.size, sourceFiles.size);
		if (!isDisposed) timeoutId = setTimeout(loop, interval);
	}

	timeoutId = setTimeout(loop, interval);

	return () => {
		isDisposed = true;
		if (timeoutId) clearTimeout(timeoutId);
	};
}

/**
 * Collects tasks that need to be done to clean up after some jobs.
 */
export class Maid {
	tasks: (() => void)[] = [];
	task = (fn: () => void) => this.tasks.push(fn);
	run = async (fn: () => any | Promise<any>) => {
		try {
			await fn();
		} catch {}
	};
	forget = () => (this.tasks = []);
	cleanup = async () => {
		for (const step of this.tasks) await this.run(step);
		this.forget();
	};
}

/**
 * child_process.spawn convenience wrapper with built in logging.
 */
export function execute(
	binPath: string,
	args: (string | number)[],
	{
		cwd,
		onLog,
		onStdout,
		onStderr,
	}: {
		cwd?: string;
		onLog?: (message: string) => void;
		onStdout?: (data: Buffer) => void;
		onStderr?: (data: Buffer) => void;
	} = {}
) {
	return new Promise<void>((resolve, reject) => {
		const finalArgs = args.map((value) => `${value}`);

		onLog?.(`Executing binary:
----------------------------------------
→ bin: "${binPath}"
→ args: ${argsToString(args)}
→ cwd: "${cwd}"
----------------------------------------`);

		const cp = CP.spawn(binPath, finalArgs, {cwd});

		cp.stdout.on('data', (data: Buffer) => {
			onStdout?.(data);
			onLog?.(`${data}`);
		});
		cp.stderr.on('data', (data: Buffer) => {
			onStderr?.(data);
			onLog?.(`${data}`);
		});

		let done = (err?: Error | null, code?: number | null) => {
			done = () => {};
			if (err) {
				reject(err);
			} else if (code != null && code > 0) {
				reject(new Error(`Process exited with code ${code}.`));
			} else {
				resolve();
			}
		};

		cp.on('error', (err) => done(err));
		cp.on('close', (code) => done(null, code));
	});
}

/**
 * FFmpeg std parser that extracts progress and logs the rest.
 */
export function makeFfmpegProgressOrLogSplitter(progress: Progress, log: (message: string) => void) {
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
					const milliseconds = isoTimeToMS(timeMatch);
					if (milliseconds <= duration) progress(milliseconds, duration);
				}
			}

			return;
		}

		// Attempt to extract duration if it wasn't yet, and we are still expecting it
		if (!duration && !durationWontHappen) {
			const durationMatch = /^ *Duration: *([\d\:\.]+),/m.exec(recentOutput)?.[1];
			if (durationMatch) duration = isoTimeToMS(durationMatch) || 0;
		}

		log?.(message);
	};
}
