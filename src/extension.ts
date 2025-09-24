import * as vscode from 'vscode';
import type markdownIt from "markdown-it";
import * as vega from 'vega';
import { compile } from 'vega-lite';

export function activate(_context: vscode.ExtensionContext) {
	// Cache rendering results, using content hash as the key
	const chartCache = new Map<string, { svg: string | null, promise: Promise<string> | null }>();

	// Generate a unique hash for the content
	function getContentHash(content: string): string {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // Convert to 32-bit integer
		}
		return hash.toString();
	}

	// Render Vega specification
	async function renderVega(spec: any) {
		const runtime = vega.parse(spec);
		const view = new vega.View(runtime, {
			renderer: "none",
			logLevel: vega.Warn // Show only warnings and above
		});
		return view.toSVG();
	}

	// Render Vega-Lite specification (compile to Vega first)
	async function renderVegaLite(spec: any) {
		// Compile Vega-Lite spec into Vega spec
		const vegaSpec = compile(spec).spec;
		return renderVega(vegaSpec);
	}

	return {
		extendMarkdownIt(md: markdownIt) {
			const defaultFence = md.renderer.rules.fence;
			if (!defaultFence) {
				return md;
			}

			md.renderer.rules.fence = (tokens, idx, options, env, self) => {
				const token = tokens[idx];
				const lang = token.info.trim().toLowerCase();
				token.info = "json";

				// Only handle vega and vega-lite code blocks
				if (!['vega', 'vega-lite'].includes(lang)) {
					return defaultFence(tokens, idx, options, env, self);
				}

				try {
					const content = token.content;
					// Use language type + content hash to avoid cache conflicts between different types with the same content
					const hash = `${lang}-${getContentHash(content)}`;
					const spec = JSON.parse(content);

					// Check cache
					if (chartCache.has(hash)) {
						const cacheEntry = chartCache.get(hash)!;
						// If a rendered result exists, return it directly
						if (cacheEntry.svg) {
							return `<figure class="vega-figure">${cacheEntry.svg}</figure>`;
						}
						// If rendering is in progress, return a loading placeholder
						return `<figure class="vega-loading">Rendering ${lang} chart...</figure>`;
					}

					// Choose rendering function based on type
					const renderFunction = lang === 'vega' ? renderVega : renderVegaLite;

					// No cache found, start rendering
					const promise = renderFunction(spec)
						.then(svg => {
							// Update cache
							chartCache.set(hash, { svg, promise: null });
							// Trigger re-render
							vscode.commands.executeCommand('markdown.preview.refresh');
							return svg;
						})
						.catch(err => {
							console.error(`${lang} rendering error:`, err);
							chartCache.set(hash, {
								svg: `<div class="vega-error">${err.message}</div>`,
								promise: null
							});
							vscode.commands.executeCommand('markdown.preview.refresh');
							return '';
						});

					// Store ongoing rendering task
					chartCache.set(hash, { svg: null, promise });

					// Return loading state on first render
					return `<figure class="vega-loading">Loading ${lang} chart...</figure>`;

				} catch (err) {
					return `<div class="vega-error">Invalid ${lang} spec: ${(err as Error).message}</div>`;
				}
			};

			return md;
		}
	};
}

export function deactivate() { }
