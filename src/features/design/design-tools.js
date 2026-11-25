import { ALL_TOOLS, FigmaAPI, renderNodesToImage } from '@open-pencil/core';

/**
 * What the design tools report to the model when a core tool cannot answer.
 * - `unknown_tool`: the name is not in the allow-list, or this core build has no such tool.
 * - `tool_failed`: core rejected the arguments, threw, or returned its `{ error }` channel.
 * - `network`: a tool that reaches the network could not reach it (offline icon lookup).
 */
export class DesignToolError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DesignToolError';
    this.code = code;
  }
}

/**
 * The core tools a design surface may call (contract §3.3). Everything else — `eval_code`,
 * `calc`, stock photos, variables, path and boolean ops — must stay out of the model's reach,
 * so this list is a gate and not a convenience.
 *
 * The JSX family (`render`, `diff_jsx`, `get_jsx`) is excluded as well: `render` builds a JSX
 * evaluator, and Mova's renderer runs under a CSP without `unsafe-eval`, so it always throws.
 * Structures are described with `create` plus nested `children` instead, so nothing here
 * produces or consumes JSX.
 */
const ALLOWED_TOOLS = new Set([
  'import_svg', 'insert_icon', 'fetch_icons', 'search_icons',
  'create_shape', 'create_page', 'delete_node', 'node_resize', 'reparent_node',
  'group_nodes', 'ungroup_node', 'clone_node', 'rename_node', 'arrange',
  'get_node', 'get_page_tree', 'find_nodes', 'query_nodes', 'get_selection',
  'select_nodes', 'list_pages', 'switch_page', 'get_current_page', 'page_bounds',
  'list_available_fonts', 'get_font_status', 'list_fonts',
  'export_image', 'export_svg', 'export_pdf',
  'update_node', 'set_fill', 'set_stroke', 'set_stroke_align', 'set_image_fill',
  'set_effects', 'set_opacity', 'set_rotation', 'set_radius', 'set_layout', 'set_layout_child',
  'set_text', 'set_font', 'set_text_resize', 'set_text_properties',
  'set_visible', 'set_locked', 'set_blend', 'set_constraints',
  'batch_update', 'describe', 'lint', 'analyze_spacing', 'analyze_typography', 'analyze_colors',
  'diff_visual', 'diff_changes',
]);

const TOOLS = new Map(ALL_TOOLS.map(def => [def.name, def]));
const MIME_TYPES = new Map([['PNG', 'image/png'], ['JPG', 'image/jpeg'], ['WEBP', 'image/webp']]);
const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
// Core tools send failures back as text, so the code has to be read off the message.
const NETWORK_HINT = /fetch|network|ENOTFOUND|Failed to fetch|offline/i;
// A schema rejection happens before the handler runs: the network was never touched.
const SCHEMA_REJECTION = 'Invalid arguments for ';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(def, message) {
  if (message.startsWith(SCHEMA_REJECTION)) return 'tool_failed';
  const networked = Array.isArray(def.capabilities) && def.capabilities.includes('network:access');
  return networked || NETWORK_HINT.test(message) ? 'network' : 'tool_failed';
}

function toToolError(def, error) {
  const message = errorMessage(error);
  return new DesignToolError(errorCode(def, message), message, { cause: error });
}

/**
 * Bridge between Mova's canvas and core's own tool layer, so no tool has to be re-implemented
 * here. `editor` is the live editor and `getCanvasKit` resolves the CanvasKit instance the
 * editor was started with — exports need the very same one.
 */
export function createDesignToolkit({ editor, getCanvasKit }) {
  let facade = null;
  let canvasKitPromise = null;

  function loadCanvasKit() {
    // Clearing the cache on failure keeps one rejected load from poisoning every later export.
    if (!canvasKitPromise) {
      canvasKitPromise = Promise.resolve()
        .then(() => getCanvasKit())
        .catch(error => {
          canvasKitPromise = null;
          throw error;
        });
    }
    return canvasKitPromise;
  }

  /** `diff_visual` exports a node that may sit on another page; otherwise export the open page. */
  function pageIdFor(options) {
    const requested = options?.pageId;
    if (typeof requested === 'string' && editor.graph.getNode(requested)) return requested;
    return editor.state.currentPageId;
  }

  /** Core's `export_image` exports the whole page when no ids are given; mirror that. */
  function idsFor(ids) {
    if (Array.isArray(ids) && ids.length > 0) return ids.map(String);
    return editor.graph.getChildren(editor.state.currentPageId).map(node => node.id);
  }

  function normaliseFormat(format) {
    const value = format == null ? 'PNG' : String(format).toUpperCase();
    if (!MIME_TYPES.has(value)) {
      throw new DesignToolError('tool_failed', `不支持的导出格式：${value}；只允许 PNG、JPG、WEBP`);
    }
    return value;
  }

  function normaliseScale(scale) {
    const value = Number(scale);
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
  }

  async function exportImage(ids, options = {}) {
    const format = normaliseFormat(options?.format);
    const scale = normaliseScale(options?.scale);
    const nodeIds = idsFor(ids);
    if (nodeIds.length === 0) throw new DesignToolError('tool_failed', '当前页还没有可以导出的图层');
    const renderer = editor.renderer;
    if (!renderer) throw new DesignToolError('tool_failed', '画布尚未就绪，暂时无法导出图片');
    let canvasKit;
    try {
      canvasKit = await loadCanvasKit();
    } catch (error) {
      throw new DesignToolError('tool_failed', `导出组件未能加载：${errorMessage(error)}`, { cause: error });
    }
    let bytes;
    try {
      // Synchronous and fallible: a selection spanning two pages throws, an empty one returns null.
      bytes = renderNodesToImage(
        canvasKit, renderer, editor.graph, pageIdFor(options), nodeIds, { scale, format },
      );
    } catch (error) {
      throw new DesignToolError('tool_failed', errorMessage(error), { cause: error });
    }
    if (!bytes || bytes.length === 0) throw new DesignToolError('tool_failed', '导出失败：选区没有可见内容');
    return { bytes, mimeType: MIME_TYPES.get(format) };
  }

  /**
   * Core's `export_image` and `diff_visual` reach the host through this property. It closes over
   * `exportImage` instead of the returned toolkit object, which does not exist yet when `sync()`
   * builds the first facade.
   */
  function attachExportImage(target) {
    target.exportImage = async (nodeIds, options) => (await exportImage(nodeIds, options)).bytes;
  }

  /** Cheap and idempotent: it runs before every tool call, so it never copies document state. */
  function sync() {
    const graph = editor.graph;
    if (!facade || facade.graph !== graph) {
      facade = new FigmaAPI(graph);
      facade.theme = 'dark';
      attachExportImage(facade);
    }
    // The renderer appears after the editor is created (and after a document reload), so mirror it.
    facade.setRenderer(editor.renderer ?? null);
    const pageId = editor.state?.currentPageId;
    if (pageId && pageId !== facade.currentPageId) {
      // FigmaAPI only has a `currentPage` setter; assigning `currentPageId` throws in strict mode.
      const page = facade.getNodeById(pageId);
      if (page) facade.currentPage = page;
    }
    return facade;
  }

  /** `switch_page` moves the facade only; without this the next `sync()` would undo the switch. */
  function adoptFacadePage() {
    const pageId = facade?.currentPageId;
    if (!pageId || pageId === editor.state?.currentPageId) return;
    if (!editor.graph.getNode(pageId)) return;
    editor.state.currentPageId = pageId;
    editor.requestRender?.();
  }

  function figma() {
    return sync();
  }

  function has(name) {
    return ALLOWED_TOOLS.has(name);
  }

  async function run(name, args) {
    const target = sync();
    if (!ALLOWED_TOOLS.has(name)) {
      throw new DesignToolError('unknown_tool', `未开放的设计工具：${String(name)}`);
    }
    const def = TOOLS.get(name);
    if (!def) {
      throw new DesignToolError('unknown_tool', `当前 core 版本没有这个设计工具：${String(name)}`);
    }
    const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    let value;
    try {
      value = await def.execute(target, input);
    } catch (error) {
      throw toToolError(def, error);
    }
    adoptFacadePage();
    // A recoverable failure is a `{ error }` answer, not a throw — it must still reach the caller.
    if (value && typeof value === 'object' && typeof value.error === 'string') {
      throw new DesignToolError(errorCode(def, value.error), value.error);
    }
    return value;
  }

  return { sync, has, run, figma, exportImage };
}
