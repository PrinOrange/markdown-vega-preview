import * as vscode from 'vscode';
import type markdownIt from "markdown-it";
import * as vega from 'vega';
import { compile } from 'vega-lite';
import { createHash } from 'crypto'; // Used for more efficient hash calculation
import jsonc from 'jsonc-parser';

// Cache entry interface
interface CacheEntry {
	svg: string | null;
	promise: Promise<string> | null;
	timestamp: number;
	accessCount: number; // Access count, used for LRU strategy
}

export function activate(_context: vscode.ExtensionContext) {
	const chartCache = new Map<string, CacheEntry>();

	// Configurable cache parameters
	const CACHE_MAX_SIZE = 20; // Reduce maximum cache size to balance memory usage
	const CACHE_TTL = 15 * 60 * 1000; // Shorten expiration time to 15 minutes
	const RENDER_TIMEOUT = 300000; // Rendering timeout (300 seconds)

	// Optimization 1: Use more efficient hash algorithm (replace simple hash)
	function getContentHash(content: string, lang: string): string {
		// Combine language, content, and version to generate hash, avoid cache conflicts after version upgrades
		return createHash('md5')
			.update(`v1:${lang}:${content}`)
			.digest('hex');
	}

	// Optimization 2: LRU + access frequency mixed cleanup strategy
	function cleanupCache() {
		if (chartCache.size <= CACHE_MAX_SIZE) { return; }

		const now = Date.now();
		const entries = Array.from(chartCache.entries());
		const validEntries = entries.filter(([_, entry]) =>
			now - entry.timestamp <= CACHE_TTL
		);

		// Remove all expired items
		entries.forEach(([key, entry]) => {
			if (now - entry.timestamp > CACHE_TTL) {
				chartCache.delete(key);
			}
		});

		// Sort valid entries by "access frequency + timestamp", keep more valuable cache entries
		if (validEntries.length > CACHE_MAX_SIZE) {
			validEntries.sort((a, b) => {
				// Prefer to keep entries with higher access count, then more recently accessed
				if (a[1].accessCount !== b[1].accessCount) {
					return b[1].accessCount - a[1].accessCount;
				}
				return b[1].timestamp - a[1].timestamp;
			});

			// Remove lower-ranked cache entries
			validEntries.slice(CACHE_MAX_SIZE).forEach(([key]) => {
				chartCache.delete(key);
			});
		}
	}

	// Optimization 3: Share rendering tasks to avoid duplicate rendering of the same content
	function getOrCreateRenderPromise(hash: string, renderFn: () => Promise<string>): Promise<string> {
		const existing = chartCache.get(hash);
		if (existing?.promise) {
			return existing.promise; // Return existing render task to avoid duplicate computation
		}

		// Add timeout control
		const promise = Promise.race([
			renderFn(),
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error('Rendering timed out')), RENDER_TIMEOUT)
			)
		]);

		chartCache.set(hash, {
			svg: null,
			promise,
			timestamp: Date.now(),
			accessCount: 1
		});

		return promise;
	}

	// Optimization 4: Vega render configuration optimization
	async function renderVega(spec: any) {
		const runtime = vega.parse(spec);
		const view = new vega.View(runtime, {
			renderer: "none",
			logLevel: vega.Error, // Only show error logs to reduce IO
		});

		return view.toSVG();
	}

	// Optimization 5: Vega-Lite compile cache
	const liteCompileCache = new Map<string, any>();
	async function renderVegaLite(spec: any) {
		const specStr = JSON.stringify(spec);
		// Check compile cache first
		if (liteCompileCache.has(specStr)) {
			return renderVega(liteCompileCache.get(specStr));
		}

		// Compile and cache result
		const vegaSpec = compile(spec).spec;
		liteCompileCache.set(specStr, vegaSpec);

		// Limit compile cache size
		if (liteCompileCache.size > 20) {
			const oldestKey = Array.from(liteCompileCache.keys()).shift();
			if (oldestKey) { liteCompileCache.delete(oldestKey); }
		}

		return renderVega(vegaSpec);
	}

	// Optimization 6: Reduce cleanup frequency to reduce performance overhead
	const cleanupInterval = setInterval(cleanupCache, 30 * 60 * 1000); // Once every 30 minutes

	return {
		extendMarkdownIt(md: markdownIt) {
			const defaultFence = md.renderer.rules.fence;
			if (!defaultFence) {
				return md;
			}

			md.renderer.rules.fence = (tokens, idx, options, env, self) => {
				const token = tokens[idx];
				const lang = token.info.trim().toLowerCase();

				if (!['vega', 'vega-lite'].includes(lang)) {
					return defaultFence(tokens, idx, options, env, self);
				}

				token.info = "json";

				try {
					const content = token.content;
					const hash = getContentHash(content, lang);

					// Optimization 7: Fast path - check cache before parsing JSON (parsing can be expensive)
					if (chartCache.has(hash)) {
						const cacheEntry = chartCache.get(hash)!;
						// Update cache metrics
						cacheEntry.timestamp = Date.now();
						cacheEntry.accessCount++;
						chartCache.set(hash, cacheEntry);

						if (cacheEntry.svg) {
							return `<figure class="vega-figure">${cacheEntry.svg}</figure>`;
						}
						return `<figure class="vega-loading">Rendering ${lang} chart...</figure>`;
					}

					// Lazy parse JSON (only when cache miss)
					const spec = jsonc.parse(content);

					// Perform lightweight cleanup (just check size, no sorting)
					if (chartCache.size > CACHE_MAX_SIZE * 1.5) {
						cleanupCache();
					}

					// Select render function
					const renderFn = lang === 'vega'
						? () => renderVega(spec)
						: () => renderVegaLite(spec);

					// Get or create render task
					const promise = getOrCreateRenderPromise(hash, renderFn)
						.then(svg => {
							chartCache.set(hash, {
								svg,
								promise: null,
								timestamp: Date.now(),
								accessCount: 1
							});
							vscode.commands.executeCommand('markdown.preview.refresh');
							return svg;
						})
						.catch(err => {
							console.error(`${lang} rendering error:`, err);
							chartCache.set(hash, {
								svg: `<div class="vega-error">${err.message}</div>`,
								promise: null,
								timestamp: Date.now(),
								accessCount: 1
							});
							vscode.commands.executeCommand('markdown.preview.refresh');
							return '';
						});

					return `<figure class="vega-loading">Loading ${lang} chart...</figure>`;

				} catch (err) {
					return `<div class="vega-error">Invalid ${lang} spec: ${(err as Error).message}</div>`;
				}
			};

			return md;
		}
	};
}

export function deactivate() {
	if (cleanupInterval) {
		clearInterval(cleanupInterval);
	}
}

let cleanupInterval: NodeJS.Timeout;
