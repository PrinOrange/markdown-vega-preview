import * as vscode from 'vscode';
import type markdownIt from "markdown-it";
import * as vega from 'vega';
import { compile } from 'vega-lite';

export function activate(_context: vscode.ExtensionContext) {
	// 缓存渲染结果，使用内容哈希作为键
	const chartCache = new Map<string, { svg: string | null, promise: Promise<string> | null }>();

	// 生成内容的唯一哈希
	function getContentHash(content: string): string {
		let hash = 0;
		for (let i = 0; i < content.length; i++) {
			const char = content.charCodeAt(i);
			hash = ((hash << 5) - hash) + char;
			hash = hash & hash; // 转换为32位整数
		}
		return hash.toString();
	}

	// 渲染Vega规范
	async function renderVega(spec: any) {
		const runtime = vega.parse(spec);
		const view = new vega.View(runtime, {
			renderer: "none",
			logLevel: vega.Warn // 只显示警告及以上级别的日志
		});
		return view.toSVG();
	}

	// 渲染Vega-Lite规范（先编译为Vega）
	async function renderVegaLite(spec: any) {
		// 将Vega-Lite规范编译为Vega规范
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

				// 只处理 vega 和 vega-lite 代码块
				if (!['vega', 'vega-lite'].includes(lang)) {
					return defaultFence(tokens, idx, options, env, self);
				}

				try {
					const content = token.content;
					// 使用语言类型 + 内容生成哈希，避免不同类型但内容相同的缓存冲突
					const hash = `${lang}-${getContentHash(content)}`;
					const spec = JSON.parse(content);

					// 检查缓存
					if (chartCache.has(hash)) {
						const cacheEntry = chartCache.get(hash)!;
						// 如果已有渲染结果，直接返回
						if (cacheEntry.svg) {
							return `<figure class="vega-figure">${cacheEntry.svg}</figure>`;
						}
						// 如果正在渲染中，返回加载占位符
						return `<figure class="vega-loading">Rendering ${lang} chart...</figure>`;
					}

					// 根据类型选择不同的渲染函数
					const renderFunction = lang === 'vega' ? renderVega : renderVegaLite;

					// 没有缓存，开始渲染
					const promise = renderFunction(spec)
						.then(svg => {
							// 更新缓存
							chartCache.set(hash, { svg, promise: null });
							// 触发重新渲染
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

					// 存储正在进行的渲染任务
					chartCache.set(hash, { svg: null, promise });

					// 第一次渲染返回加载状态
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
