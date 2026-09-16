import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildCustomFooterComponent } from "./footer.ts";
import type { ExtensionState } from "./state.ts";

/**
 * 刷新状态展示。
 * 模式 A：用户开启接管式自定义 Footer（内联 14.1%/1.0M (auto:75%) 风格）；
 * 模式 B：默认的标准非侵入式 setStatus，不破坏原生或其他第三方 footer。
 */
export function updateStatusDisplay(state: ExtensionState, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  if (state.config.customFooter) {
    if (!state.footerRegistered) {
      state.footerRegistered = true;
      ctx.ui.setFooter((tui, theme, footerData) => {
        state.requestRenderFn = () => tui.requestRender();
        const factory = buildCustomFooterComponent(
          ctx,
          () => state.config,
          () => state.isCompacting
        );
        const comp = factory(tui, theme, footerData);
        return {
          ...comp,
          dispose: () => {
            comp.dispose();
            state.footerRegistered = false;
            state.requestRenderFn = undefined;
          },
        };
      });
    } else {
      state.requestRenderFn?.();
    }
    return;
  }

  const theme = ctx.ui.theme;
  const statusText = state.isCompacting
    ? theme
      ? theme.fg("warning", "compacting...")
      : "compacting..."
    : theme
      ? `${theme.fg("dim", "compact:")} ${theme.fg("accent", `${state.config.threshold}%`)}`
      : `compact: ${state.config.threshold}%`;

  ctx.ui.setStatus("auto-compact", statusText);
  state.requestRenderFn?.();
}