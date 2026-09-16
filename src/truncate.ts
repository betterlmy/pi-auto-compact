/** 工具结果内容块（text/image 等的宽松结构，避免依赖 SDK 内部类型细节） */
type ContentBlock = Record<string, unknown>;

/** 截断标记宽度（字符），预留以保证首尾之和不超过上限 */
const OMITTED_MARKER_WIDTH = 40;

function isTextBlock(block: unknown): block is { text: string } & ContentBlock {
  return !!block && typeof block === "object" && typeof (block as any).text === "string";
}

/**
 * 计算文本内容块的总字符数。
 */
function textLength(content: ContentBlock[]): number {
  let total = 0;
  for (const block of content) {
    if (isTextBlock(block)) total += block.text.length;
  }
  return total;
}

/**
 * 对单个文本块执行首尾保留截断。
 * 返回 null 表示无需修改。
 */
function truncateText(text: string, maxChars: number): string | null {
  if (text.length <= maxChars) return null;

  // 上限小于标记宽度时，直接硬截，无法再保留首尾
  if (maxChars <= OMITTED_MARKER_WIDTH) {
    return text.slice(0, maxChars);
  }

  const budget = maxChars - OMITTED_MARKER_WIDTH;
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${text.slice(0, head)}\n[...truncated ${text.length - head - tail} chars...]\n${text.slice(-tail)}`;
}

/**
 * 对工具结果内容块执行预防性截断，返回 null 表示无需修改（零拷贝路径）。
 *
 * 仅缩短超限的 text 块，不动 image 块与其他类型；
 * 截断标记明确告知模型内容被省略，避免其误以为已获得完整输出。
 */
export function truncateToolResultContent(content: unknown, maxChars: number): ContentBlock[] | null {
  if (!maxChars || maxChars <= 0) return null;
  if (!Array.isArray(content) || content.length === 0) return null;
  const blocks = content as ContentBlock[];

  // 快速路径：总长度未超限时原样返回，避免每次工具调用都重建数组
  if (textLength(blocks) <= maxChars) return null;

  // 逐块预算：总超限时按文本块数量均摊上限，超限块保留首尾
  const textBlockCount = blocks.filter((b) => isTextBlock(b)).length;
  const perBlockLimit = Math.max(1, Math.floor(maxChars / Math.max(1, textBlockCount)));

  let modified = false;
  const result = blocks.map((block) => {
    if (!isTextBlock(block)) return block;
    const truncated = truncateText(block.text, perBlockLimit);
    if (truncated === null) return block;
    modified = true;
    return { ...block, text: truncated };
  });

  // 逐块均摊后仍可能整体超限（块数多、每块略超），再做一次整体收紧
  if (modified && textLength(result) > maxChars) {
    const tightLimit = Math.max(1, Math.floor(maxChars / Math.max(1, result.length)));
    return result.map((block) => {
      if (!isTextBlock(block)) return block;
      const t = truncateText(block.text, tightLimit);
      return t === null ? block : { ...block, text: t };
    });
  }

  return modified ? result : null;
}
