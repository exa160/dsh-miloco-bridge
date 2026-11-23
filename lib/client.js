/**
 * dsh-miloco-bridge — browser half.
 *
 * The settings half opens from the 「Miloco 家庭助手」 page (its 「配置」
 * button) and covers:
 *
 * 1. whether Miloco is reachable; if not, one-click deploy or connect;
 * 2. the household workspace directory and whether it stays registered;
 * 3. push destination: a conversation and an optional model;
 * 4. the dedicated agent's operating mode.
 *
 * The household overview itself lives on the 「Miloco 家庭助手」 page.
 *
 * Model selection deliberately has no "deployment default" pseudo-entry:
 * leaving it empty means the conversation keeps its own model.
 *
 * @module dsh-miloco-bridge/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-miloco-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement

    /**
     * Client services this half declares.
     *
     * - `slots` — the slot registry every registration goes through.
     * - `uiWorkspace` — session navigation (open/start).
     * - `workspaces` — workspace snapshot source and idempotent `create`,
     *   used only when the host reports no household `workspaceId`.
     * - `uiConversation` — conversation Definition registry.
     */
    const inject = ['slots', 'uiWorkspace', 'workspaces', 'uiConversation']

    /** Settings API prefix, mirrored from the host half. */
    const API = '/dsh-miloco-bridge/api'

    const STYLE_ID = 'dsh-miloco-bridge-settings-style'
    const SESSION_LIST_ID = 'dsh-miloco-bridge-session-list'

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = `
.dsh-miloco-bridge-settings {
  /* The configuration modal is rendered inside a centred panel container:
     the settings keep their own left alignment instead of inheriting it. */
  text-align: left;
  --mc-border: var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  --mc-border-soft: var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  --mc-bg: var(--dsw-alias-bg-l1, rgba(128,128,128,.035));
  --mc-bg-soft: var(--dsw-alias-bg-l2, rgba(128,128,128,.07));
  --mc-text: var(--dsw-alias-label-primary, inherit);
  --mc-text-2: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  --mc-text-3: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72));
  --mc-accent: var(--dsw-alias-brand-primary, #4a7edc);
  --mc-success: var(--dsw-alias-state-success-primary, #3c9a5a);
  --mc-error: var(--dsw-alias-state-error-primary, #c85a50);
  font-size: 13px; line-height: 1.65; max-width: 820px; color: var(--mc-text);
}
.dsh-miloco-bridge-settings h3 { font-size: 14px; margin: 0 0 10px; font-weight: 500; color: var(--dsw-alias-label-primary, inherit); }
.dsh-miloco-bridge-settings .cardHead { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
.dsh-miloco-bridge-settings .cardHead h3 { margin: 0; }
.dsh-miloco-bridge-settings .iconBtn {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--mc-text-3);
}
.dsh-miloco-bridge-settings .iconBtn:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); border-color: transparent;
}
.dsh-miloco-bridge-settings .iconBtn.spinning svg { animation: dsh-miloco-spin .9s linear infinite; }
@keyframes dsh-miloco-spin { to { transform: rotate(360deg); } }
/* 卡片沿用原生设置区的材质：settings-card 描边 + settings-card 填充 +
   radius-xl，与「设置 → 模型 / 插件」里的卡片同一套。 */
.dsh-miloco-bridge-settings .card {
  border: .5px solid var(--dsw-alias-settings-card-stroke, var(--mc-border));
  border-radius: var(--dsw-radius-xl, 20px); padding: 12px 14px;
  margin-bottom: 10px; background: var(--dsw-alias-settings-card-fill, transparent);
}
.dsh-miloco-bridge-settings .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-top: 10px; }
.dsh-miloco-bridge-settings .stat {
  display: flex; flex-direction: column; padding: 9px 11px; border-radius: 8px;
  background: transparent; border: 1px solid var(--mc-border-soft);
}
.dsh-miloco-bridge-settings .stat .k { color: var(--mc-text-3); font-size: 11px; }
.dsh-miloco-bridge-settings .stat .v { font-size: 17px; font-weight: 600; line-height: 1.35; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-miloco-bridge-settings .row { display: flex; align-items: center; gap: 8px; margin: 8px 0; flex-wrap: wrap; }
.dsh-miloco-bridge-settings .row > label { min-width: 96px; color: var(--mc-text-2); }
.dsh-miloco-bridge-settings .field { display: flex; flex-direction: column; gap: 4px; margin: 10px 0; }
.dsh-miloco-bridge-settings .formGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 4px 14px; margin: 10px 0; }
.dsh-miloco-bridge-settings .formGrid .field { margin: 0; }
.dsh-miloco-bridge-settings .field > label { color: var(--mc-text-2); font-size: 12px; }
.dsh-miloco-bridge-settings .fieldRow { display: flex; align-items: center; gap: 8px; }
.dsh-miloco-bridge-settings .fieldRow input:not([type="checkbox"]):not([type="radio"]) { flex: 1 1 auto; width: auto; min-width: 0; }
.dsh-miloco-bridge-settings .switchRow {
  display: flex; align-items: center; gap: 8px; cursor: pointer;
  color: var(--mc-text-1); font-size: 13px;
}
.dsh-miloco-bridge-settings .switchRow input { width: 15px; height: 15px; accent-color: var(--mc-accent, #4a7edc); }
.dsh-miloco-bridge-settings .row > select,
.dsh-miloco-bridge-settings .row > input:not([type="checkbox"]):not([type="radio"]) { flex: 1 1 220px; width: auto; }
.dsh-miloco-bridge-settings .statusRow {
  display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; align-items: center;
  gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--mc-border-soft);
}
.dsh-miloco-bridge-settings .statusRow:last-of-type { border-bottom: 0; }
.dsh-miloco-bridge-settings .statusLabel { color: var(--mc-text-2); }
.dsh-miloco-bridge-settings .statusValue { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-miloco-bridge-settings .statusCheck { justify-self: end; color: var(--mc-success); font-weight: 700; font-size: 14px; line-height: 1; }
.dsh-miloco-bridge-settings .statusCross { justify-self: end; color: var(--mc-error); font-weight: 700; font-size: 14px; line-height: 1; }
.dsh-miloco-bridge-settings .statusEnd { justify-self: end; }
.dsh-miloco-bridge-settings .statusValue > a, .dsh-miloco-bridge-settings .statusValue > code {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
/* 表单控件照抄原生设置区的输入框：32px 高、radius-md、border-l4 描边、
   bg-layer-1 底色；下拉用同一个 12px 箭头，不留系统原生箭头。 */
.dsh-miloco-bridge-settings select,
.dsh-miloco-bridge-settings input:not([type="checkbox"]):not([type="radio"]) {
  flex: 0 0 auto; width: 100%; height: 32px; box-sizing: border-box;
  padding: 0 10px; border-radius: var(--dsw-radius-md, 12px);
  border: .5px solid var(--dsw-alias-border-l4, var(--mc-border));
  background: var(--dsw-alias-bg-layer-1, transparent); color: inherit;
  font: inherit; font-size: 14px; line-height: 22px; outline: none;
}
.dsh-miloco-bridge-settings select {
  cursor: pointer; appearance: none; padding-right: 30px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 12px 12px;
}
.dsh-miloco-bridge-settings input[type="checkbox"] {
  flex: 0 0 auto; width: auto; min-width: 0; height: auto; margin: 2px 0 0;
  accent-color: var(--mc-accent);
}
.dsh-miloco-bridge-settings select:focus, .dsh-miloco-bridge-settings input:focus {
  border-color: var(--dsw-alias-state-business-primary, var(--mc-accent));
  box-shadow: none;
}
.dsh-miloco-bridge-settings input::placeholder { color: var(--dsw-alias-label-dimmed, var(--mc-text-3)); }
/* 按钮与原生设置区一致：36px 高、radius-md、主按钮用品牌填充色。 */
.dsh-miloco-bridge-settings button {
  box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center;
  gap: 4px; height: 36px; padding: 0 14px; border-radius: var(--dsw-radius-md, 12px);
  border: .5px solid var(--dsw-alias-border-l3, var(--mc-border));
  background: transparent; color: var(--dsw-alias-label-primary, inherit);
  font: inherit; font-size: 14px; line-height: 22px; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, opacity .15s ease;
}
@media (hover: hover) {
  .dsh-miloco-bridge-settings button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }
}
.dsh-miloco-bridge-settings button.primary {
  background: var(--dsw-alias-button-primary-fill, var(--mc-accent)); border-color: transparent;
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
@media (hover: hover) {
  .dsh-miloco-bridge-settings button.primary:hover:not(:disabled) {
    background: var(--dsw-alias-button-primary-hover, var(--mc-accent));
  }
}
.dsh-miloco-bridge-settings button.dangerBtn { color: var(--mc-error); border-color: var(--mc-error); background: transparent; }
.dsh-miloco-bridge-settings button:disabled { opacity: .45; cursor: default; }
.dsh-miloco-bridge-settings .pill {
  display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px;
  font-size: 11.5px; line-height: 1.6; border: 1px solid var(--mc-border); color: var(--mc-text-2);
  white-space: nowrap;
}
.dsh-miloco-bridge-settings .pill.ok { border-color: var(--mc-success); color: var(--mc-success); }
.dsh-miloco-bridge-settings .pill.bad { border-color: var(--mc-error); color: var(--mc-error); }
.dsh-miloco-bridge-settings .pill.warn { border-color: #b8860b; color: #b8860b; }
.dsh-miloco-bridge-settings .muted { color: var(--mc-text-3); font-size: 12px; }
.dsh-miloco-bridge-settings .modeList { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin: 12px 0 8px; }
.dsh-miloco-bridge-settings .modeItem {
  display: flex; align-items: flex-start; gap: 9px; margin: 0; padding: 10px 12px;
  border: 1px solid var(--mc-border); border-radius: 9px; background: transparent;
  cursor: pointer; transition: border-color .15s ease, background .15s ease;
}
.dsh-miloco-bridge-settings .modeItem:hover { border-color: var(--mc-text-3); }
.dsh-miloco-bridge-settings .modeItem.selected { border-color: var(--mc-accent); background: var(--mc-bg-soft); }
.dsh-miloco-bridge-settings .modeItem input[type="radio"] {
  flex: 0 0 auto; min-width: 0; width: auto; margin: 2px 0 0; padding: 0;
  border: 0; background: transparent; accent-color: var(--mc-accent);
}
.dsh-miloco-bridge-settings .modeText { display: flex; flex: 1 1 auto; flex-direction: column; gap: 3px; min-width: 0; text-align: left; }
.dsh-miloco-bridge-settings .modeText strong { font-size: 13px; }
.dsh-miloco-bridge-settings .modeText .muted { margin: 0; }
.dsh-miloco-bridge-settings a { color: var(--mc-accent); text-decoration: none; }
.dsh-miloco-bridge-settings a:hover { text-decoration: underline; }
.dsh-miloco-bridge-settings .danger { border: 1px solid var(--mc-error); border-radius: 8px; padding: 10px 12px; margin-top: 10px; background: transparent; }
.dsh-miloco-bridge-settings .danger h4 { margin: 0 0 6px; font-size: 13px; color: var(--mc-error); }
.dsh-miloco-bridge-settings .danger label { display: flex; gap: 6px; align-items: flex-start; margin: 6px 0; font-size: 12px; }
.dsh-miloco-bridge-settings .guide { margin: 8px 0 0; padding: 10px 12px; border-radius: 7px; border: 1px solid var(--mc-border-soft); background: transparent; }
.dsh-miloco-bridge-settings .guide h4 { margin: 8px 0 4px; font-size: 13px; }
.dsh-miloco-bridge-settings .guide ul { margin: 4px 0; padding-left: 18px; }
.dsh-miloco-bridge-settings .guide li { margin: 2px 0; }
.dsh-miloco-bridge-settings .versionSub {
  display: flex; flex-wrap: wrap; align-items: center; flex-basis: 100%;
  min-width: 0; color: var(--mc-text-3); font-size: 12px; line-height: 1.6;
}
.dsh-miloco-bridge-settings .versionSub > * + *::before {
  content: '·'; margin: 0 6px; color: var(--mc-text-3);
}
.dsh-miloco-bridge-settings .versionSub .versionLink {
  border: 0; background: transparent; padding: 0; border-radius: 0; height: auto;
  color: var(--mc-accent); font: inherit; font-size: 12px; line-height: inherit; cursor: pointer;
}
.dsh-miloco-bridge-settings .versionSub .versionLink:hover:not(:disabled) {
  background: transparent; text-decoration: underline;
}
.dsh-miloco-bridge-settings .versionDirty { color: #b8860b; }
.dsh-miloco-bridge-settings .versionNote { margin-top: 6px; }
.dsh-miloco-bridge-settings .versionManualPanel { margin-top: 8px; }
.dsh-miloco-bridge-settings .versionCommand {
  margin: 0; padding: 8px 10px; border-radius: 6px; max-height: 120px; overflow: auto;
  border: 1px solid var(--mc-border-soft); background: var(--dsw-alias-bg-base, transparent);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap; word-break: break-word;
}
.dsh-miloco-bridge-settings code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }

/* 窄屏：状态行仍是「标签 | 值 | 结果」三段，表单网格也保持三列并排，
   只把每段的最小宽度放宽，让 390px 宽的屏幕也放得下三段；真正放不下时
   由 auto-fit 自然回流，不在这里强制拆成单列。 */
@media (max-width: 767px) {
  .dsh-miloco-bridge-settings .statusRow {
    grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px;
  }
  .dsh-miloco-bridge-settings .statusLabel { white-space: nowrap; }
  .dsh-miloco-bridge-settings .formGrid {
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 4px 10px;
  }
  .dsh-miloco-bridge-settings .row > label { min-width: 0; }
}
.dsh-miloco-preset-helpbar { display: inline-flex; align-items: center; gap: 2px; margin-right: auto; }
.dsh-miloco-preset-helpbtn {
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  font: inherit; font-size: 12px; line-height: 1.5; padding: 2px 6px; border-radius: 5px; cursor: pointer;
}
.dsh-miloco-preset-helpbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
/* 预设说明弹层：遮罩与面板都走原生设置弹层的那套 token。 */
.dsh-miloco-guide-backdrop {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  padding: 24px; background: var(--dsw-alias-bg-mask-1, rgba(0,0,0,.24));
  backdrop-filter: var(--dsw-mask-blur, none);
}
.dsh-miloco-guide-modal {
  display: flex; flex-direction: column; width: min(640px, 100%); height: min(600px, 100%);
  max-height: 100%; overflow: hidden; padding: 0; border-radius: var(--dsw-radius-panel, 28px); border: 0;
  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #111);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.18));
}
@media (max-width: 767px) {
  .dsh-miloco-guide-backdrop { padding: 0; background: var(--dsw-alias-bg-layer-2, #fff); }
  .dsh-miloco-guide-modal { width: 100%; height: 100%; max-height: none; border-radius: 0; }
}
.dsh-miloco-guide-header { flex: none; padding: 24px 24px 20px 28px; }
.dsh-miloco-guide-title-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dsh-miloco-guide-title { margin: 0; font-size: 20px; font-weight: 600; line-height: 28px; }
.dsh-miloco-guide-intro { margin: 8px 0 0; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95)); font-size: 14px; line-height: 22px; }
.dsh-miloco-guide-close {
  flex: none; width: 32px; height: 32px; border: 0; border-radius: 8px; padding: 0;
  background: transparent; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.8));
  font: inherit; font-size: 22px; line-height: 1; cursor: pointer;
}
.dsh-miloco-guide-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.dsh-miloco-guide-tabs {
  flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 4px;
  margin: 0 28px 22px; padding: 4px; border-radius: 10px;
  background: var(--dsw-alias-bg-l2, #f5f5f5);
}
.dsh-miloco-guide-tab {
  border: 1px solid transparent; border-radius: 8px; padding: 7px 10px;
  background: transparent; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  font: inherit; font-size: 14px; line-height: 20px; cursor: pointer;
}
.dsh-miloco-guide-tab.selected {
  background: var(--dsw-alias-bg-base, #fff);
  border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  color: var(--dsw-alias-label-primary, #111);
  box-shadow: 0 1px 2px rgba(0,0,0,.04);
}
.dsh-miloco-guide-panel {
  flex: 1; min-height: 0; overflow-y: auto; padding: 0 24px 24px 28px;
  color: var(--dsw-alias-label-primary, #111); font-size: 16px; overflow-wrap: anywhere;
}
.dsh-miloco-guide-panel h3 { margin: 28px 0 10px; font-size: 16px; font-weight: 600; line-height: 24px; }
.dsh-miloco-guide-panel h3:first-child { margin-top: 0; }
.dsh-miloco-guide-panel p { margin: 0 0 16px; font-size: 16px; line-height: 1.625; }
.dsh-miloco-guide-panel ul { margin: 0 0 16px; padding-left: 22px; }
.dsh-miloco-guide-panel li { margin: 6px 0; font-size: 16px; line-height: 1.6; }
.dsh-miloco-guide-panel blockquote { margin: 10px 0 14px; padding: 12px 16px; border: 0; border-radius: 10px; background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-l2, #f5f5f5)); }
.dsh-miloco-guide-panel blockquote p { margin: 0; }
.dsh-miloco-bridge-settings pre {
  margin: 8px 0 0; padding: 8px 10px; border-radius: 6px; max-height: 260px; overflow: auto;
  border: 1px solid var(--mc-border-soft); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; line-height: 1.5; white-space: pre-wrap;
}

/* ---- Miloco 家庭概览（main 面板内容） ---- */
.dsh-miloco-dash {
  max-width: 980px; margin: 0 auto; padding: 24px 28px 40px; color: var(--dsw-alias-label-primary, inherit);
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.6;
  /* The host panel clips its column (overflow hidden), so the dashboard
     scrolls itself instead of growing past the viewport. */
  max-height: 100%; overflow-y: auto; overscroll-behavior: contain;
}
/* The header keeps the title and its two actions on one line, however narrow
   the panel gets: the title gives up space first, the actions never wrap. */
.dsh-miloco-dash-head { display: flex; align-items: center; gap: 12px; flex-wrap: nowrap; }
.dsh-miloco-dash-head-main { flex: 1 1 auto; min-width: 0; }
.dsh-miloco-dash-title {
  font-size: 20px; font-weight: 600; line-height: 28px; letter-spacing: .01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dsh-miloco-dash-actions { flex: none; display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; }
.dsh-miloco-dash-actions button {
  white-space: nowrap; flex: none;
  height: 30px; padding: 0 13px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  background: transparent; color: inherit; font: inherit; font-size: 12.5px; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, opacity .15s ease;
}
@media (hover: hover) {
  .dsh-miloco-dash-actions button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
}
.dsh-miloco-dash-actions button.primary {
  background: var(--dsw-alias-brand-primary, #4a7edc); border-color: transparent; color: #fff; font-weight: 500;
}
.dsh-miloco-dash-actions button:disabled { opacity: .45; cursor: default; }
.dsh-miloco-dash-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 14px 0 2px; }
.dsh-miloco-dash-chip {
  display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
  padding: 3px 9px; border-radius: 999px; border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  background: var(--dsw-alias-bg-l1, rgba(128,128,128,.04)); color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  font-size: 12px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-miloco-dash-chip.warn { border-color: var(--dsw-alias-state-warning-primary, #c58a2a); color: var(--dsw-alias-state-warning-primary, #c58a2a); }
.dsh-miloco-dash-chipdot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); }
.dsh-miloco-dash-chip.ok .dsh-miloco-dash-chipdot { background: var(--dsw-alias-state-success-primary, #3c9a5a); }
.dsh-miloco-dash-chip.warn .dsh-miloco-dash-chipdot { background: currentColor; }
.dsh-miloco-dash-card {
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  border-radius: var(--dsw-radius-xl, 12px); padding: 14px 16px 6px; margin-top: 12px;
  background: var(--dsw-alias-bg-l1, rgba(128,128,128,.02));
}
.dsh-miloco-dash-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-bottom: 8px; }
.dsh-miloco-dash-card-title { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.dsh-miloco-dash-card-head h3 { margin: 0; font-size: 14px; font-weight: 600; white-space: nowrap; }
.dsh-miloco-dash-meta { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); font-size: 12px; white-space: nowrap; }
.dsh-miloco-dash-score {
  flex: none; padding: 1px 8px; border-radius: 999px; font-size: 11.5px;
  color: var(--dsw-alias-state-success-primary, #3c9a5a);
  border: .5px solid var(--dsw-alias-state-success-primary, #3c9a5a);
}
.dsh-miloco-dash-rooms { columns: 210px 3; column-gap: 8px; padding-bottom: 10px; }
.dsh-miloco-dash-room {
  break-inside: avoid; margin-bottom: 8px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  border-radius: 10px; padding: 0 10px; background: transparent;
}
.dsh-miloco-dash-room > summary {
  display: flex; align-items: center; gap: 8px; padding: 8px 0; cursor: pointer;
  list-style: none; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95)); font-size: 12.5px;
  user-select: none;
}
.dsh-miloco-dash-room > summary::-webkit-details-marker { display: none; }
.dsh-miloco-dash-room > summary:hover { color: var(--dsw-alias-label-primary, inherit); }
.dsh-miloco-dash-chev {
  flex: none; width: 12px; text-align: center; font-size: 15px; line-height: 1;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); transition: transform .15s ease;
}
.dsh-miloco-dash-room[open] > summary .dsh-miloco-dash-chev { transform: rotate(90deg); }
.dsh-miloco-dash-room-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-miloco-dash-room-count { flex: none; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); }
.dsh-miloco-dash-room-count.ok { color: var(--dsw-alias-state-success-primary, #3c9a5a); }
.dsh-miloco-dash-room-count.off { color: var(--dsw-alias-state-error-primary, #c85a50); }
.dsh-miloco-dash-room-bar { flex: none; width: 54px; height: 4px; border-radius: 2px; overflow: hidden; background: var(--dsw-alias-border-l1, rgba(128,128,128,.14)); }
.dsh-miloco-dash-room-bar i { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-success-primary, #3c9a5a); }
.dsh-miloco-dash-list { list-style: none; margin: 0 0 6px; padding: 0; max-height: 300px; overflow: auto; }
.dsh-miloco-dash-room .dsh-miloco-dash-list { padding-left: 0; max-height: 220px; border-top: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.1)); }
.dsh-miloco-dash-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.1)); min-width: 0; }
.dsh-miloco-dash-devdot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(128,128,128,.5)); }
.dsh-miloco-dash-devdot.ok { background: var(--dsw-alias-state-success-primary, #3c9a5a); }
.dsh-miloco-dash-main { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.dsh-miloco-dash-tag {
  flex: none; padding: 0 6px; border-radius: 999px; font-size: 10.5px; line-height: 16px;
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72));
  border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
}
.dsh-miloco-dash-link { border: 0; background: transparent; color: inherit; font: inherit; padding: 0; cursor: pointer; text-align: left; }
@media (hover: hover) { .dsh-miloco-dash-link:hover { color: var(--dsw-alias-brand-primary, #4a7edc); } }
.dsh-miloco-dash-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
.dsh-miloco-dash-grid .dsh-miloco-dash-card { margin-top: 0; }
.dsh-miloco-dash-summary .dsh-miloco-dash-chips { margin: 0 0 8px; }
.dsh-miloco-dash-stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 8px;
  padding: 2px 0 12px;
}
.dsh-miloco-dash-stat {
  display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 10px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  background: var(--dsw-alias-bg-l2, rgba(128,128,128,.04));
}
.dsh-miloco-dash-stat .k { color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); font-size: 11px; }
.dsh-miloco-dash-stat .v {
  font-size: 15px; font-weight: 600; line-height: 1.4; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
}
/* ---- 配置弹层：沿用 DSH 原生设置面板的壳 ----
   原生设置（SettingsRoot）的构成是：全屏遮罩（bg-mask-1 + 遮罩模糊）+
   居中 800px 面板（bg-layer-2、radius-panel、elevation-prominent），窄屏下
   面板铺满视口、去掉圆角。这里照抄同一套 token 与尺寸，PC 与移动端便与原生
   保持一致，而不是各画一套。 */
.dsh-miloco-dash-config-backdrop {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: center; justify-content: center;
}
.dsh-miloco-dash-config-mask {
  position: absolute; inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .24));
  backdrop-filter: var(--dsw-mask-blur, none);
}
.dsh-miloco-dash-config {
  position: relative; z-index: 1;
  display: flex; flex-direction: column;
  width: 800px;
  height: min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))));
  max-width: calc(100vw - 48px);
  border-radius: var(--dsw-radius-panel, 28px);
  overflow: hidden;
  background: var(--dsw-alias-bg-layer-2, #fff);
  box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgba(0, 0, 0, .18));
}
.dsh-miloco-dash-config-head {
  flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px;
  height: 54px; padding: 20px 14px 8px 24px; box-sizing: border-box;
}
.dsh-miloco-dash-config-head h3 {
  margin: 0; font-size: 16px; line-height: 24px; font-weight: 500;
  color: var(--dsw-alias-label-primary, inherit);
}
.dsh-miloco-dash-config-close {
  flex: none; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 8px);
  background: transparent; color: var(--dsw-alias-label-primary, inherit); cursor: pointer;
}
@media (hover: hover) {
  .dsh-miloco-dash-config-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
}
.dsh-miloco-dash-config-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 0 24px 24px;
}
.dsh-miloco-dash-config-body > .dsh-miloco-bridge-settings { max-width: none; padding: 0; }

/* 窄屏与原生一致：整屏铺开、去掉圆角，内容两侧留 16px 安全边距。 */
@media (max-width: 767px) {
  .dsh-miloco-dash-config-backdrop { background: var(--dsw-alias-bg-layer-2, #fff); }
  .dsh-miloco-dash-config-mask { display: none; }
  .dsh-miloco-dash-config { width: 100%; max-width: none; height: 100%; border-radius: 0; }
  .dsh-miloco-dash-config-head { height: auto; padding: 20px 16px 8px; }
  .dsh-miloco-dash-config-body { padding: 0 16px 24px; }
}
.dsh-miloco-dash-empty { padding: 18px 2px 20px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); font-size: 12.5px; }
.dsh-miloco-dash-loading { padding: 28px 2px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); font-size: 12.5px; }

/* ---- 独立状态页：加载中 / 未配置 / 读取失败（整页居中，不复用仪表盘布局） ---- */
.dsh-miloco-dash-state {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; min-height: 100%; max-height: 100%; box-sizing: border-box;
  overflow-y: auto; overscroll-behavior: contain;
  padding: 40px 24px 48px;
  color: var(--dsw-alias-label-primary, inherit); text-align: center;
  font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.6;
}
.dsh-miloco-dash-state-card {
  width: min(520px, 100%); padding: 26px 26px 24px; border-radius: 16px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  background: var(--dsw-alias-bg-l1, rgba(128,128,128,.02));
}
.dsh-miloco-dash-state-mark {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; margin-bottom: 14px; border-radius: 14px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  background: var(--dsw-alias-bg-l2, rgba(128,128,128,.05));
  color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
}
.dsh-miloco-dash-state-title { font-size: 18px; font-weight: 600; line-height: 26px; }
.dsh-miloco-dash-state-sub {
  margin-top: 8px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
  font-size: 13px; line-height: 1.75;
}
.dsh-miloco-dash-state-error {
  margin-top: 8px; color: var(--dsw-alias-state-error-primary, #c85a50);
  font-size: 12.5px; line-height: 1.7; overflow-wrap: anywhere;
}
.dsh-miloco-dash-steps {
  list-style: none; margin: 20px 0 0; padding: 0; display: flex; flex-direction: column; gap: 12px;
  text-align: left;
}
.dsh-miloco-dash-step { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; }
.dsh-miloco-dash-step-mark {
  flex: none; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  font-size: 11px; line-height: 1; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72));
}
.dsh-miloco-dash-step.done .dsh-miloco-dash-step-mark {
  border-color: var(--dsw-alias-state-success-primary, #3c9a5a);
  color: var(--dsw-alias-state-success-primary, #3c9a5a);
}
.dsh-miloco-dash-step-text { flex: 1 1 240px; min-width: 0; }
.dsh-miloco-dash-step-text strong { display: block; font-size: 13px; font-weight: 600; }
.dsh-miloco-dash-step-text span {
  display: block; margin-top: 2px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72));
  font-size: 12px; line-height: 1.65; overflow-wrap: anywhere;
}
.dsh-miloco-dash-state-actions {
  margin-top: 22px; display: flex; align-items: center; justify-content: center; gap: 8px; flex-wrap: wrap;
}
.dsh-miloco-dash-state-actions button {
  height: 32px; padding: 0 16px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  background: transparent; color: inherit; font: inherit; font-size: 12.5px; cursor: pointer;
  transition: background-color .15s ease, border-color .15s ease, opacity .15s ease;
}
@media (hover: hover) {
  .dsh-miloco-dash-state-actions button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
}
.dsh-miloco-dash-state-actions button.primary {
  background: var(--dsw-alias-brand-primary, #4a7edc); border-color: transparent; color: #fff; font-weight: 500;
}
.dsh-miloco-dash-state-actions button:disabled { opacity: .45; cursor: default; }
.dsh-miloco-dash-note {
  max-width: 520px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72));
  font-size: 11.5px; line-height: 1.75; text-align: left;
}
.dsh-miloco-dash-bind {
  flex: 1 1 100%; margin-top: 2px; padding: 10px 12px; border-radius: 10px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  background: var(--dsw-alias-bg-l2, rgba(128,128,128,.04));
}
.dsh-miloco-dash-bind-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.dsh-miloco-dash-connect {
  flex: 1 1 100%; margin-top: 6px; padding: 10px 12px; border-radius: 10px;
  border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14));
  background: var(--dsw-alias-bg-l2, rgba(128,128,128,.04));
}
.dsh-miloco-dash-connect-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dsh-miloco-dash-connect-row input {
  flex: 1 1 260px; height: 30px; box-sizing: border-box; padding: 0 10px;
  border-radius: var(--dsw-radius-md, 12px);
  border: .5px solid var(--dsw-alias-border-l4, var(--mc-border));
  background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; font: inherit; font-size: 13px;
}
.dsh-miloco-dash-log {
  margin: 8px 0 0; max-height: 180px; overflow: auto; white-space: pre-wrap;
  font-size: 11px; line-height: 1.5; color: var(--mc-text-2);
  text-align: left;
}
.dsh-miloco-deploy-log {
  margin: 4px 0 0; max-height: 160px; overflow: auto; white-space: pre-wrap;
  font-size: 11px; line-height: 1.5; color: var(--mc-text-2);
}
.dsh-miloco-dash-extlink {
  color: var(--dsw-alias-brand-primary, #4a7edc); text-decoration: none; font-size: 12.5px;
}
@media (hover: hover) { .dsh-miloco-dash-extlink:hover { text-decoration: underline; } }
.dsh-miloco-dash-bind-steps {
  margin: 10px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px;
  font-size: 12px; color: var(--dsw-alias-label-secondary, rgba(128,128,128,.95));
}
.dsh-miloco-dash-bind-steps li { display: flex; flex-direction: column; gap: 4px; }
.dsh-miloco-dash-bind-btn {
  align-self: flex-start; height: 28px; padding: 0 12px; border-radius: var(--dsw-radius-md, 8px);
  border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  background: transparent; color: inherit; font: inherit; font-size: 12px; cursor: pointer;
}
@media (hover: hover) {
  .dsh-miloco-dash-bind-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
}
.dsh-miloco-dash-bind-btn:disabled { opacity: .45; cursor: default; }
.dsh-miloco-dash-bind-input {
  width: 100%; box-sizing: border-box; min-height: 58px; resize: vertical; padding: 6px 8px;
  border-radius: 7px; border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  background: var(--dsw-alias-bg-base, transparent); color: inherit; font: inherit; font-size: 12px;
}
.dsh-miloco-dash-bind-hint {
  color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.72)); font-size: 11.5px; line-height: 1.6;
}
.dsh-miloco-dash-bind-ok {
  margin-top: 8px; color: var(--dsw-alias-state-success-primary, #3c9a5a); font-size: 12px;
}
.dsh-miloco-dash-spinner {
  width: 20px; height: 20px; border-radius: 50%;
  border: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.24));
  border-top-color: var(--dsw-alias-brand-primary, #4a7edc);
  animation: dsh-miloco-spin .9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .dsh-miloco-dash-spinner { animation: none; }
}
.dsh-miloco-dash-error {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: 12px 0 0; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px);
  border: .5px solid var(--dsw-alias-state-error-primary, #c85a50);
  color: var(--dsw-alias-state-error-primary, #c85a50);
}

/* ---- 折叠推送卡片（照抄 DSH 定时任务触发通知卡片） ---- */
.dsh-miloco-push-root {
  min-width: 0;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: var(--dsw-radius-xl, var(--dsw-alias-radius-xl, 12px));
  background: var(--dsw-alias-turn-trigger-bg, var(--dsw-alias-markdown-code-block));
  transition: background-color 100ms ease;
}
@media (hover: hover) {
  .dsh-miloco-push-root:hover {
    background: var(--dsw-alias-turn-trigger-bg-hover, var(--dsw-alias-interactive-bg-hover));
  }
}
.dsh-miloco-push-header {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px 16px;
  border: 0; background: none; color: var(--dsw-alias-label-tertiary);
  transition: color 100ms ease; font: inherit; text-align: left; cursor: pointer;
}
@media (hover: hover) {
  .dsh-miloco-push-header:hover { color: var(--dsw-alias-label-secondary); }
}
.dsh-miloco-push-icon { display: inline-flex; flex: none; color: inherit; }
.dsh-miloco-push-title {
  flex: 1; min-width: 0; overflow-wrap: anywhere;
  font-size: var(--dsh-content-font-size, 14px);
}
.dsh-miloco-push-time { flex: none; margin-left: auto; color: inherit; font: var(--dsw-font-xxs-12); }
.dsh-miloco-push-chevron { flex: none; color: inherit; }
.dsh-miloco-push-chevron.open { transform: rotate(180deg); }
.dsh-miloco-push-body { padding: 0 16px 12px 40px; }
.dsh-miloco-push-explanation {
  margin: 8px 0; color: var(--dsw-alias-label-secondary); font: var(--dsw-font-xxs-12);
}
.dsh-miloco-push-content {
  max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font: var(--dsw-font-xxs-12);
}
@media (prefers-reduced-motion: reduce) {
  .dsh-miloco-push-root, .dsh-miloco-push-header { transition: none; }
}
`
      document.head.appendChild(style)
    }

    async function call(path, init) {
      const response = await fetch(`${API}${path}`, init)
      const text = await response.text()
      let body
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(`返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || body.ok === false) {
        throw new Error(body.error || `HTTP ${response.status}`)
      }
      return body
    }

    /**
     * Build model options. The first option is "follow the conversation";
     * there is no pseudo-entry for any deployment default.
     * @param {any} status - Settings payload.
     * @returns {any[]} Option elements.
     */
    function modelOptions(status) {
      const options = [h('option', { key: '__follow__', value: '' }, '跟随该对话自己选的模型')]
      for (const provider of status?.providers ?? []) {
        const group = []
        for (const model of provider.models ?? []) {
          group.push(h('option', {
            key: `${provider.id}/${model.id}`,
            value: `${provider.id}/${model.id}`,
          }, `${provider.name} / ${model.name || model.id}`))
        }
        if (group.length > 0) {
          options.push(h('optgroup', { key: provider.id, label: provider.name }, group))
        }
      }
      return options
    }

    /**
     * Read the reasoning-effort options advertised by the selected model.
     * @param {any} status - Settings payload.
     * @param {string} modelValue - `${provider}/${model}` selection.
     * @returns {{id: string, name?: string, description?: string}[]} Effort options.
     */
    function effortOptions(status, modelValue) {
      if (!modelValue) return []
      const [providerId, ...rest] = modelValue.split('/')
      const modelId = rest.join('/')
      const provider = (status?.providers ?? []).find(item => item.id === providerId)
      const model = (provider?.models ?? []).find(item => item.id === modelId)
      return Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : []
    }

    /**
     * Build the datalist entries for conversations.
     * @param {any} status - Settings payload.
     * @returns {any[]} Option elements.
     */
    function sessionOptions(status) {
      const sessions = status?.sessions ?? []
      const options = []
      for (const session of sessions) {
        const title = session.title || session.id
        const tags = [
          session.lastMiloco ? '上次 miloco' : '',
          session.live ? '' : '已归档',
          session.agentPreset ? `预设 ${session.agentPreset}` : '',
        ].filter(Boolean)
        const label = tags.length ? `${title} — ${session.id}（${tags.join(' · ')}）` : `${title} — ${session.id}`
        options.push(h('option', { key: session.id, value: session.id, label }, label))
      }
      return options
    }

    /**
     * DSH 0.2.1 only ships guide dialogs for built-in presets. Add equivalent
     * explanation/usage buttons to the custom Miloco preset card so the same
     * help is reachable from 「设置 → Agent 预设」. This is a defensive DOM
     * enhancement: if DSH changes the card structure, it silently does nothing.
     */
    const PRESET_GUIDE = {
      title: 'Miloco 家庭助手',
      intro: {
        explanation: '只读和管家两种模式决定这个预设能做什么。',
        usage: '新建任务时选择「Miloco 家庭助手」，说明要完成什么、涉及哪个房间或家人。',
      },
      content: {
        explanation: [
          '<h3>保留哪些能力</h3>',
          '<p>保留 DSH 通用 Agent 的对话与工具调用；米家设备、摄像头、感知、规则/任务与家庭档案',
          '是它独有的能力，且只在这个预设内出现。</p>',
          '<h3>什么时候选</h3>',
          '<p>想要联动家居设备时：只需要了解家里情况时选只读；需要操作设备或维护家庭信息时选管家。',
          '涉及门锁、燃气、摄像头开关等动作时，技能层会要求二次确认。</p>',
          '<p>模式说明与示例见「设置 → 插件 → Miloco」。</p>',
        ].join(''),
        usage: [
          '<h3>查看家里情况</h3>',
          '<blockquote><p>客厅现在有人吗？刚才门口发生了什么？</p></blockquote>',
          '<p>用摄像头画面和感知事件回答，不控制设备。</p>',
          '<h3>操作设备或执行场景</h3>',
          '<blockquote><p>把客厅灯打开；执行回家模式。</p></blockquote>',
          '<p>需要管家模式；控制前会先确认设备与参数。</p>',
          '<h3>维护家庭信息</h3>',
          '<blockquote><p>记一下孩子每天喝几杯水；奶奶对什么过敏？</p></blockquote>',
          '<p>用于家庭档案、成员与宠物登记，以及任务创建。</p>',
        ].join(''),
      },
    }

    /**
     * Open a read-only help dialog matching DSH's native preset guide layout.
     * @param {'explanation'|'usage'} kind - Initial guide page.
     */
    function openPresetGuide(kind) {
      if (typeof document === 'undefined' || !document.body) return
      document.querySelector('.dsh-miloco-guide-backdrop')?.remove()
      const backdrop = document.createElement('div')
      backdrop.className = 'dsh-miloco-guide-backdrop'
      const modal = document.createElement('div')
      modal.className = 'dsh-miloco-guide-modal'
      modal.setAttribute('role', 'dialog')
      modal.setAttribute('aria-modal', 'true')

      const header = document.createElement('div')
      header.className = 'dsh-miloco-guide-header'
      const titleRow = document.createElement('div')
      titleRow.className = 'dsh-miloco-guide-title-row'
      const title = document.createElement('h2')
      title.className = 'dsh-miloco-guide-title'
      title.textContent = PRESET_GUIDE.title
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'dsh-miloco-guide-close'
      close.textContent = '×'
      close.setAttribute('aria-label', '关闭')
      const intro = document.createElement('p')
      intro.className = 'dsh-miloco-guide-intro'
      titleRow.append(title, close)
      header.append(titleRow, intro)

      const tabs = document.createElement('div')
      tabs.className = 'dsh-miloco-guide-tabs'
      const tabExplanation = document.createElement('button')
      tabExplanation.type = 'button'
      tabExplanation.className = 'dsh-miloco-guide-tab'
      tabExplanation.textContent = '模式说明'
      const tabUsage = document.createElement('button')
      tabUsage.type = 'button'
      tabUsage.className = 'dsh-miloco-guide-tab'
      tabUsage.textContent = '如何使用'
      tabs.append(tabExplanation, tabUsage)

      const panel = document.createElement('div')
      panel.className = 'dsh-miloco-guide-panel'

      const setPage = next => {
        const active = next === 'usage' ? 'usage' : 'explanation'
        panel.innerHTML = PRESET_GUIDE.content[active]
        panel.dataset.guidePage = active
        intro.textContent = PRESET_GUIDE.intro[active]
        tabExplanation.classList.toggle('selected', active === 'explanation')
        tabUsage.classList.toggle('selected', active === 'usage')
      }
      tabExplanation.addEventListener('click', () => setPage('explanation'))
      tabUsage.addEventListener('click', () => setPage('usage'))
      setPage(kind)

      modal.append(header, tabs, panel)
      backdrop.append(modal)

      const dismiss = () => {
        backdrop.remove()
        document.removeEventListener('keydown', onKey)
      }
      const onKey = event => {
        if (event.key === 'Escape') dismiss()
      }
      close.addEventListener('click', dismiss)
      backdrop.addEventListener('click', event => {
        if (event.target === backdrop) dismiss()
      })
      document.addEventListener('keydown', onKey)
      document.body.append(backdrop)
      close.focus()
    }

    /**
     * Add help buttons to the custom Miloco preset card when it appears.
     * @param {any} ctx - Browser plugin context.
     */
    function installPresetGuide(ctx) {
      if (typeof document === 'undefined' || !document.body) return
      const enhance = () => {
        const card = document.querySelector('[data-agent-preset-id="miloco"]')
        if (!card || card.dataset.dshMilocoGuide === '1') return
        const foot = card.querySelector('[class*="cardFoot"]')
        if (!foot || foot.querySelector('.dsh-miloco-preset-helpbar')) return
        const bar = document.createElement('span')
        bar.className = 'dsh-miloco-preset-helpbar'
        const makeButton = (label, kind) => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = 'dsh-miloco-preset-helpbtn'
          button.textContent = label
          button.setAttribute('aria-label', `${label}: Miloco 家庭助手`)
          button.addEventListener('click', event => {
            event.preventDefault()
            event.stopPropagation()
            openPresetGuide(kind)
          })
          return button
        }
        bar.append(makeButton('模式说明', 'explanation'), makeButton('如何使用', 'usage'))
        foot.insertBefore(bar, foot.firstChild)
        card.dataset.dshMilocoGuide = '1'
      }
      const observer = new MutationObserver(enhance)
      observer.observe(document.body, { childList: true, subtree: true })
      enhance()
      try {
        ctx.effect?.(() => () => observer.disconnect(), 'dsh-miloco: preset guide')
      } catch { /* 客户端页面卸载时忽略 */ }
    }

    function MilocoSettingsTab() {
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [saved, setSaved] = React.useState(null)
      const [sessionId, setSessionId] = React.useState('')
      const [sessionInput, setSessionInput] = React.useState('')
      const sessionFocusCleared = React.useRef(false)
      const [modelValue, setModelValue] = React.useState('')
      const [reasoningEffort, setReasoningEffort] = React.useState('')
      const [deployLog, setDeployLog] = React.useState('')
      const [connectOpen, setConnectOpen] = React.useState(false)
      const [connectUrl, setConnectUrl] = React.useState('')
      const [connectToken, setConnectToken] = React.useState('')
      const [connectPushToken, setConnectPushToken] = React.useState('')
      const [mode, setMode] = React.useState('readonly')
      const [perceptionLevel, setPerceptionLevel] = React.useState('all')
      const [guideOpen, setGuideOpen] = React.useState(false)
      const [uninstallOpen, setUninstallOpen] = React.useState(false)
      const [removeData, setRemoveData] = React.useState(false)
      const [removeSource, setRemoveSource] = React.useState(false)
      const [confirmText, setConfirmText] = React.useState('')
      const [uninstallBusy, setUninstallBusy] = React.useState(false)
      const [uninstallResult, setUninstallResult] = React.useState(null)
      const [versionInfo, setVersionInfo] = React.useState(null)
      const [versionBusy, setVersionBusy] = React.useState(false)
      const [versionError, setVersionError] = React.useState(null)
      const [versionCommandOpen, setVersionCommandOpen] = React.useState(false)
      const [upgradeStatus, setUpgradeStatus] = React.useState(null)
      const [upgradeConfirmOpen, setUpgradeConfirmOpen] = React.useState(false)
      const [upgradeBusy, setUpgradeBusy] = React.useState(false)
      const [upgradePolling, setUpgradePolling] = React.useState(false)
      const [targetMode, setTargetMode] = React.useState('archive')
      const [homePath, setHomePath] = React.useState('')
      const [homeDraft, setHomeDraft] = React.useState('')
      const [homeSource, setHomeSource] = React.useState('')
      const [homeArchiveId, setHomeArchiveId] = React.useState('')
      const [homeEnabled, setHomeEnabled] = React.useState(true)
      const [homeBusy, setHomeBusy] = React.useState(false)
      const [homeNotice, setHomeNotice] = React.useState(null)
      const [homeError, setHomeError] = React.useState(null)
      const [tokenBusy, setTokenBusy] = React.useState(false)
      const [tokenNotice, setTokenNotice] = React.useState(null)

      const reload = React.useCallback(() => {
        setError(null)
        call('/status')
          .then((payload) => {
            setStatus(payload)
            const targetSession = payload.overlay?.push?.target?.sessionId ?? ''
            setSessionId(targetSession)
            setSessionInput(targetSession)
            sessionFocusCleared.current = false
            const provider = payload.overlay?.push?.model?.provider ?? ''
            const model = payload.overlay?.push?.model?.model ?? ''
            setModelValue(provider && model ? `${provider}/${model}` : '')
            setReasoningEffort(provider && model ? (payload.overlay?.push?.model?.reasoningEffort ?? '') : '')
            setConnectUrl(payload.connection?.baseUrl ?? '')
            setMode(payload.mode?.id ?? 'readonly')
            setPerceptionLevel(payload.overlay?.push?.perception?.minLevel ?? payload.push?.perception?.minLevel ?? 'all')
            setTargetMode(payload.overlay?.push?.target?.mode || payload.push?.target?.mode || 'archive')
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        call('/home')
          .then((payload) => {
            setHomePath(payload.path ?? '')
            setHomeDraft(payload.path ?? '')
            setHomeSource(payload.dirSource ?? '')
            setHomeArchiveId(payload.archiveSessionId ?? '')
            setHomeEnabled(payload.enabled !== false)
          })
          .catch(() => { /* 工作区不可用时保留空值，页面允许继续操作其它设置 */ })
      }, [])

      const rotateToken = React.useCallback(() => {
        setTokenBusy(true)
        setTokenNotice(null)
        call('/push-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
          .then((payload) => {
            setTokenNotice(payload.note ?? '已生成新的推送令牌')
            reload()
          })
          .catch((cause) => setTokenNotice(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setTokenBusy(false))
      }, [reload])

      const loadVersion = React.useCallback((refresh = false) => {
        setVersionBusy(true)
        setVersionError(null)
        call(`/version${refresh ? '?refresh=1' : ''}`)
          .then((payload) => {
            setVersionInfo(payload)
            setUpgradeStatus(payload.upgradeStatus ?? null)
            if (payload.error) setVersionError(payload.error)
          })
          .catch((cause) => setVersionError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setVersionBusy(false))
      }, [])

      const pollUpgrade = React.useCallback(() => {
        setUpgradePolling(true)
        const started = Date.now()
        const tick = () => {
          call('/upgrade/status')
            .then((payload) => {
              const status = payload.status
              setUpgradeStatus(status)
              if (status && ['done', 'failed', 'idle'].includes(status.phase)) {
                setUpgradePolling(false)
                loadVersion(true)
                return
              }
              if (Date.now() - started > 5 * 60_000) {
                setUpgradePolling(false)
                loadVersion(true)
                return
              }
              window.setTimeout(tick, 3000)
            })
            .catch(() => {
              // The upgrade restarts the backend; treat this as the restart phase.
              setUpgradeStatus({ phase: 'restarting' })
              if (Date.now() - started > 5 * 60_000) {
                setUpgradePolling(false)
                loadVersion(true)
                return
              }
              window.setTimeout(tick, 3000)
            })
        }
        tick()
      }, [loadVersion])

      const runUpgrade = React.useCallback(() => {
        setUpgradeBusy(true)
        setVersionError(null)
        call('/upgrade', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
          .then(() => {
            setUpgradeConfirmOpen(false)
            setUpgradeStatus({ phase: 'starting' })
            pollUpgrade()
          })
          .catch((cause) => setVersionError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setUpgradeBusy(false))
      }, [pollUpgrade])

      React.useEffect(() => {
        reload()
        loadVersion(false)
      }, [reload, loadVersion])

      const refreshSessions = React.useCallback(() => {
        call('/sessions')
          .then((payload) => {
            setStatus((previous) => previous
              ? { ...previous, sessions: payload.sessions, lastMilocoSession: payload.last }
              : previous)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      }, [])

      const save = React.useCallback(() => {
        setBusy(true)
        setSaved(null)
        setError(null)
        const [provider, ...rest] = modelValue.split('/')
        const model = rest.join('/')
        const efforts = effortOptions(status, modelValue)
        const effort = modelValue && efforts.some(item => item.id === reasoningEffort)
          ? reasoningEffort
          : ''
        call('/target', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            provider: modelValue ? provider : '',
            model: modelValue ? model : '',
            reasoningEffort: effort,
            perceptionLevel,
            mode: targetMode,
          }),
        })
          .then((payload) => {
            setSaved('已保存')
            setStatus((previous) => previous ? { ...previous, overlay: payload.overlay } : previous)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [sessionId, modelValue, reasoningEffort, perceptionLevel, targetMode, status])

      const saveHome = React.useCallback(() => {
        const dir = homeDraft.trim()
        if (!dir) {
          setHomeError('目录不能为空')
          return
        }
        setHomeBusy(true)
        setHomeError(null)
        setHomeNotice(null)
        call('/home', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ dir }),
        })
          .then((payload) => {
            setHomePath(payload.path ?? dir)
            setHomeDraft(payload.path ?? dir)
            setHomeSource(payload.dirSource ?? 'overlay')
            setHomeArchiveId(payload.archiveSessionId ?? '')
            setHomeEnabled(payload.enabled !== false)
            setHomeNotice(payload.previousPath && payload.previousPath !== payload.path
              ? `已切换目录；旧注册 ${payload.previousPath} 保留`
              : '已保存')
          })
          .catch((cause) => setHomeError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setHomeBusy(false))
      }, [homeDraft])

      /**
       * Turn the pinned household workspace on or off.
       * @param {boolean} value - The wanted state.
       * @returns {void}
       */
      const saveHomeEnabled = React.useCallback((value) => {
        setHomeBusy(true)
        setHomeError(null)
        setHomeNotice(null)
        call('/home', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: value }),
        })
          .then((payload) => {
            setHomeEnabled(payload.enabled !== false)
            setHomeNotice(payload.enabled === false
              ? '已关闭置顶工作区；家庭会话归到「未分组」'
              : '已启用置顶工作区')
          })
          .catch((cause) => setHomeError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setHomeBusy(false))
      }, [])

      const deploy = React.useCallback(() => {
        setBusy(true)
        setError(null)
        call('/deploy', { method: 'POST' })
          .then(() => {
            const poll = () => {
              call('/deploy')
                .then((payload) => {
                  setDeployLog(payload.log ?? '')
                  if (payload.state?.running) {
                    window.setTimeout(poll, 3000)
                  } else {
                    setBusy(false)
                    reload()
                  }
                })
                .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
            }
            poll()
          })
          .catch((cause) => { setError(cause instanceof Error ? cause.message : String(cause)); setBusy(false) })
      }, [reload])

      // A deployment started elsewhere (another tab, a restart) must still
      // show its progress instead of a stale connection error.
      const followDeploy = React.useCallback(() => {
        call('/deploy')
          .then((payload) => {
            setDeployLog(payload.log ?? '')
            if (payload.state?.running) window.setTimeout(followDeploy, 3000)
          })
          .catch(() => { /* the log is a nicety, not a requirement */ })
      }, [])

      React.useEffect(() => {
        if (!status?.deploy?.running) return undefined
        followDeploy()
        return undefined
      }, [status?.deploy?.running, followDeploy])

      const saveMode = React.useCallback((next) => {
        setBusy(true)
        setError(null)
        call('/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        })
          .then((payload) => {
            setMode(payload.mode?.id ?? next)
            setSaved(`已切到「${payload.mode?.label ?? next}」，重启 DSH 后生效`)
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [])

      const connect = React.useCallback(() => {
        setBusy(true)
        setError(null)
        call('/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: connectUrl,
            token: connectToken,
            ...(connectPushToken ? { pushToken: connectPushToken } : {}),
          }),
        })
          .then((payload) => {
            setSaved(payload.reachable ? '连接成功，立即生效' : '已保存，但暂时连不上')
            setConnectOpen(false)
            reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }, [connectUrl, connectToken, connectPushToken, reload])

      const uninstall = React.useCallback(() => {
        if (confirmText !== 'UNINSTALL') return
        setUninstallBusy(true)
        setUninstallResult(null)
        setError(null)
        call('/uninstall', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: confirmText, removeData, removeSource }),
        })
          .then((payload) => {
            setUninstallResult(payload.note || '已停止 Miloco 服务并清除插件连接。')
            setUninstallOpen(false)
            setConfirmText('')
            setRemoveData(false)
            setRemoveSource(false)
            reload()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setUninstallBusy(false))
      }, [confirmText, removeData, removeSource, reload])

      if (error && !status) {
        return h('div', { className: 'dsh-miloco-bridge-settings' },
          h('div', { className: 'card' },
            h('h3', null, 'Miloco'),
            h('span', { className: 'pill bad' }, '读取失败'),
            h('div', { className: 'muted' }, error)))
      }
      if (!status) {
        return h('div', { className: 'dsh-miloco-bridge-settings' },
          h('div', { className: 'card' }, h('div', { className: 'muted' }, '正在读取 Miloco 状态…')))
      }

      const backend = status.backend ?? {}
      const connection = status.connection ?? {}
      const push = status.push ?? {}
      const adapter = status.adapter ?? {}
      const reachable = Boolean(backend.reachable)
      const cards = []
      // The deployment state drives the connect card below, so it has to be
      // read before that card is built.
      const deployState = status.deploy ?? {}
      const deployStepLabels = {
        starting: '准备中',
        'already-running': 'Miloco 已在运行',
        'starting-existing': '启动已有安装',
        'downloading-installer': '下载安装器',
        installing: '安装中',
        'starting-service': '启动服务',
        wiring: '写入配置',
        done: '已完成',
        failed: '失败',
      }

      const connectChanged = connectUrl.trim() !== String(connection.baseUrl ?? '').trim()
        || connectToken.trim() !== ''
        || connectPushToken.trim() !== ''
      const connectForm = connectOpen
        ? h('div', null,
          h('div', { className: 'row' },
            h('input', {
              type: 'text', value: connectUrl, placeholder: 'http://miloco.local:1810',
              onChange: (event) => setConnectUrl(event.target.value),
            })),
          h('div', { className: 'row' },
            h('input', {
              type: 'password', value: connectToken,
              placeholder: `后端令牌（DSH → Miloco，${connection.tokenSet ? '留空 = 保持现有' : '可留空'}）`,
              onChange: (event) => setConnectToken(event.target.value),
            })),
          h('div', { className: 'row' },
            h('input', {
              type: 'password', value: connectPushToken,
              placeholder: `推送令牌（Miloco → DSH，${push.tokenSet ? '留空 = 保持现有' : '留空 = 自动生成'}）`,
              onChange: (event) => setConnectPushToken(event.target.value),
            }),
            h('button', {
              type: 'button', disabled: tokenBusy, onClick: rotateToken,
            }, tokenBusy ? '生成中…' : (push.tokenSet ? '重新生成推送令牌' : '生成推送令牌'))),
          tokenNotice
            ? h('div', { className: 'row' },
              h('span', { className: 'pill ok' }, tokenNotice))
            : null,
          h('div', { className: 'row' },
            h('button', { type: 'button', onClick: () => setConnectOpen(false) }, '取消'),
            h('button', {
              type: 'button', className: 'primary',
              disabled: busy || !connectUrl.trim() || !connectChanged,
              onClick: connect,
            }, '连接')))
        : null

      // ---------------------------------------------------------------- 部署 / 连接
      if (!reachable) {
        cards.push(h(MilocoDeployCard, {
          deployState,
          deployLog,
          deployStepLabels,
          backendError: backend.error,
          baseUrl: connection.baseUrl,
          busy,
          deploying: Boolean(deployState.running),
          onDeploy: deploy,
          onConnect: () => {
            const opening = !connectOpen
            setConnectOpen(opening)
            if (opening) setUninstallOpen(false)
          },
        }))
      }

      // ---------------------------------------------------------------- 运行模式
      const modes = status.modes ?? []
      cards.push(h('div', { className: 'card', key: 'mode' },
        h('h3', null, 'Miloco 家庭助手 · 运行模式'),
        h('div', { className: 'muted' },
          '米家工具与技能只挂在「Miloco 家庭助手」这个 Agent 预设上，普通对话完全不受影响。'),
        h('div', { className: 'muted' }, '模式决定这个预设手里有哪些工具：'),
        h('div', { className: 'modeList' }, modes.map(item => h('label', {
          key: item.id,
          className: `modeItem${mode === item.id ? ' selected' : ''}`,
        },
        h('input', {
          type: 'radio', name: 'dsh-miloco-bridge-mode', checked: mode === item.id,
          onChange: () => saveMode(item.id),
        }),
        h('div', { className: 'modeText' },
          h('strong', null, item.label),
          h('div', { className: 'muted' }, item.description))))),
        h('div', { className: 'muted' },
          '切换后重启 DSH（或重新挂载该预设）才生效；已有会话保留创建时拿到的工具集。'),
        h('div', { className: 'row' },
          h('button', { type: 'button', disabled: busy, onClick: () => setGuideOpen(!guideOpen) },
            guideOpen ? '收起使用说明' : '查看模式说明与用法'))))

      if (guideOpen) {
        cards.push(h('div', { className: 'card', key: 'guide' },
          h('h3', null, 'Miloco 家庭助手 · 使用说明'),
          h('div', { className: 'muted' },
            'DSH 的「模式说明 / 如何使用」弹窗目前只为内置预设提供；Miloco 是第三方预设，'
            + '等价说明放在这里。'),
          h('div', { className: 'guide' },
            h('h4', null, '模式说明'),
            h('ul', null,
              h('li', null, h('strong', null, '只读模式：'), '只能查设备、问摄像头、看档案与用量；写工具不会被注册，不会控制任何设备。'),
              h('li', null, h('strong', null, '管家模式：'), '在只读能力上增加设备控制、场景触发、通知、规则/任务、档案写入、成员与宠物登记。')),
            h('h4', null, '如何使用'),
            h('ul', null,
              h('li', null, '新建会话时选择「Miloco 家庭助手」；其他对话不会出现 miloco_* 工具。'),
              h('li', null, '在本页选择运行模式；切换后重启 DSH 或重新挂载预设生效。'),
              h('li', null, '推送目标：默认投到归档会话；切到「指定会话」后，会话留空 = 上一次触发 Miloco 的会话，也可以指定任意会话。'),
              h('li', null, '模型留空 = 跟随该对话；选择模型后，该对话会用指定模型处理推送。')),
            h('h4', null, '可以这样问'),
            h('ul', null,
              h('li', null, '“客厅现在有人吗？” / “刚才门口发生了什么？”'),
              h('li', null, '“把客厅灯打开” / “执行回家模式”'),
              h('li', null, '“奶奶对什么过敏？” / “记一下孩子每天喝几杯水”'),
              h('li', null, '“最近 token 用量多少？” / “为什么这条规则没触发？”')))))
      }

      // ---------------------------------------------------------------- 家庭工作区
      const sourceLabel = homeSource === 'overlay'
        ? '设置页覆盖'
        : homeSource === 'config'
          ? '插件配置'
          : '默认目录'
      cards.push(h('div', { className: 'card', key: 'workspace' },
        h('h3', null, '家庭工作区'),
        h('div', { className: 'field' },
          h('label', null, '目录'),
          h('div', { className: 'fieldRow' },
            h('input', {
              type: 'text',
              value: homeDraft,
              placeholder: homePath || '家庭工作区目录',
              onChange: (event) => setHomeDraft(event.target.value),
            }),
            h('button', { type: 'button', disabled: homeBusy, onClick: saveHome }, homeBusy ? '保存中…' : '保存'))),
        h('div', { className: 'field' },
          h('label', null, '启用置顶工作区'),
          h('label', { className: 'switchRow' },
            h('input', {
              type: 'checkbox',
              checked: homeEnabled,
              disabled: homeBusy,
              onChange: (event) => saveHomeEnabled(event.target.checked),
            }),
            h('span', null, homeEnabled ? '已启用：家庭工作区置顶显示' : '已关闭：家庭会话归到「未分组」'))),
        h('div', { className: 'muted' }, `当前：${homePath || '—'}（${sourceLabel}）`),
        homeArchiveId ? h('div', { className: 'muted' }, `推送归档会话：${homeArchiveId}`) : null,
        h('div', { className: 'muted' },
          '修改目录会注册新的工作区；旧目录的工作区注册不会自动删除，目录与其中的会话不受影响。'),
        h('div', { className: 'muted' },
          '工作区从侧边栏被删除后，插件会在 30 秒内自动恢复。'),
        h('div', { className: 'muted' },
          '关闭「启用置顶工作区」后不再注册工作区，已经在里面的家庭会话会归到「未分组」。'),
        homeNotice || homeError
          ? h('div', { className: 'row' },
            homeNotice ? h('span', { className: 'pill ok' }, homeNotice) : null,
            homeError ? h('span', { className: 'pill bad' }, homeError) : null)
          : null))

      // ---------------------------------------------------------------- 推送目标
      const lastSession = status.lastMilocoSession ?? ''
      const selectedSession = (status.sessions ?? []).find(session => session.id === sessionId)
      const sessionPlaceholder = sessionInput === '' && sessionId
        ? `当前：${selectedSession?.title || sessionId}；输入搜索或会话 id`
        : lastSession
          ? `留空 = 上一次触发 miloco 的会话（${lastSession}）`
          : '留空 = 上一次触发 miloco 的会话（还没有）'
      const selectedEfforts = effortOptions(status, modelValue)
      const effortValue = selectedEfforts.some(item => item.id === reasoningEffort)
        ? reasoningEffort
        : ''
      cards.push(h('div', { className: 'card', key: 'target' },
        h('h3', null, '推送目标'),
        h('div', { className: 'field' },
          h('label', null, '投递方式'),
          h('select', {
            value: targetMode,
            onChange: (event) => setTargetMode(event.target.value),
          }, [
            h('option', { key: 'archive', value: 'archive' }, '归档会话'),
            h('option', { key: 'session', value: 'session' }, '指定会话'),
          ])),
        targetMode === 'session'
          ? h('div', { className: 'field' },
            h('label', null, '对话会话'),
          h('div', { className: 'fieldRow' },
            h('input', {
              type: 'text',
              list: SESSION_LIST_ID,
              value: sessionInput,
              placeholder: sessionPlaceholder,
              onFocus: () => {
                if (sessionId) {
                  sessionFocusCleared.current = true
                  setSessionInput('')
                }
              },
              onChange: (event) => {
                const value = event.target.value
                sessionFocusCleared.current = false
                setSessionInput(value)
                if (!value || (status.sessions ?? []).some(session => session.id === value)) {
                  setSessionId(value)
                }
              },
              onBlur: () => {
                const value = sessionInput.trim()
                if (sessionFocusCleared.current && value === '') {
                  setSessionInput(sessionId)
                } else {
                  setSessionId(value)
                  setSessionInput(value)
                }
                sessionFocusCleared.current = false
              },
            }),
            h('datalist', { id: SESSION_LIST_ID }, sessionOptions(status)),
            h('button', { type: 'button', disabled: busy, onClick: refreshSessions }, '刷新会话'))) : null,
        targetMode === 'archive'
          ? h('div', { className: 'muted' },
            `所有推送进入固定归档会话 ${homeArchiveId || 'miloco-archive'}（不可修改），可在家庭概览页直接打开。`)
          : h('div', { className: 'muted' },
            '留空 = 投到「上一次触发 miloco 的会话」，也就是最近一次调用过米家工具的对话。'
            + '也可以从下拉里选任意对话，或直接填会话 id。'),
        h('div', { className: 'formGrid' },
          h('div', { className: 'field' },
            h('label', null, '模型'),
            h('select', {
              value: modelValue,
              onChange: (event) => {
                setModelValue(event.target.value)
                setReasoningEffort('')
              },
            }, modelOptions(status))),
          selectedEfforts.length > 0
            ? h('div', { className: 'field' },
              h('label', null, '推理强度'),
              h('select', {
                value: effortValue,
                onChange: (event) => setReasoningEffort(event.target.value),
              }, [
                h('option', { key: '__model_default__', value: '' }, '跟随模型默认'),
                ...selectedEfforts.map(item => h('option', {
                  key: item.id,
                  value: item.id,
                }, item.name || item.id)),
              ]))
            : null,
          h('div', { className: 'field' },
            h('label', null, '感知等级'),
            h('select', {
              // 旧的「全部事件」(all) 与「低及以上」(low) 放行的事件完全一样
              // （all 的下限就是最低一档），所以下拉里只保留后三档；已存的
              // all 显示成「低及以上」，不动配置本身。
              value: perceptionLevel === 'all' ? 'low' : perceptionLevel,
              onChange: (event) => setPerceptionLevel(event.target.value),
            }, [
              h('option', { key: 'low', value: 'low' }, '低及以上'),
              h('option', { key: 'medium', value: 'medium' }, '中及以上'),
              h('option', { key: 'high', value: 'high' }, '仅高优先级'),
            ]))),
        h('div', { className: 'muted' },
          '低于所选等级的感知建议不会投递到 DSH；规则、任务、onboarding 与普通对话事件不受影响。'),
        h('div', { className: 'row' },
          h('button', { type: 'button', className: 'primary', disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
          saved ? h('span', { className: 'pill ok' }, saved) : null,
          error ? h('span', { className: 'pill bad' }, error) : null),
        h('div', { className: 'muted' },
          `保存位置：${status.overlayFile ?? '—'}（立即生效，不必重启）`)))

      // ---------------------------------------------------------------- 运行状态
      const versionData = versionInfo?.version ?? null
      const upgradeInfo = versionInfo?.upgrade ?? null
      const currentVersion = upgradeInfo?.current || versionData?.version || ''
      const latestVersion = upgradeInfo?.latest || ''
      const deployKind = upgradeInfo?.deploy_kind
        || (currentVersion && /\.dev\d*|\+/.test(currentVersion) ? 'dev' : '')
      const hasUpdate = Boolean(upgradeInfo?.has_update)
      const isDevDeployment = deployKind === 'dev'
      const upgradeSource = upgradeInfo?.source || 'backend'
      const mirrorCheck = upgradeSource === 'mirror'
      const upgradeUnavailable = !upgradeInfo || upgradeInfo.reachable === false
      const releaseUrl = upgradeInfo?.release_url || ''
      const sourceRoot = versionInfo?.sourceRoot || deployState.sourceDir || ''
      const gitDirty = Boolean(versionData?.git?.dirty)
      const commitShort = versionData?.git?.commit_short || ''
      const upgradePhase = upgradeStatus?.phase || ''
      const upgradeLogPath = upgradeStatus?.logPath || ''
      const upgradePhaseLabels = {
        idle: '空闲',
        starting: '准备中',
        downloading: '下载中',
        installing: '安装中',
        restarting: '服务重启中',
        done: '已完成',
        failed: '失败',
      }
      const devUpdateCommand = sourceRoot
        ? `cd ${sourceRoot} && git pull --ff-only && bash scripts/install.sh --dev --skip-openclaw && systemctl --user restart miloco.service`
        : ''
      const versionPill = versionInfo?.reachable === false
        ? ['bad', '不可用']
        : !versionInfo
          ? ['', versionBusy ? '读取中' : '未知']
          : isDevDeployment
            ? ['', '源码部署']
            : upgradeUnavailable
              ? ['warn', '检查失败']
              : hasUpdate
                ? ['warn', '有新版本']
                : ['ok', '已是最新']

      cards.push(h('div', { className: 'card', key: 'runtime' },
        h('div', { className: 'cardHead' },
          h('h3', null, '运行状态'),
          h('button', {
            type: 'button',
            className: `iconBtn${busy || versionBusy ? ' spinning' : ''}`,
            title: '刷新运行状态与版本信息',
            'aria-label': '刷新运行状态与版本信息',
            disabled: busy,
            onClick: () => {
              reload()
              loadVersion(true)
            },
          }, h('svg', {
            viewBox: '0 0 24 24',
            width: 16,
            height: 16,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.8,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            'aria-hidden': 'true',
          },
          h('path', { d: 'M20 11a8.1 8.1 0 0 0-15.5-2m-.5-4v4h4' }),
          h('path', { d: 'M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4' })))),
        h('div', { className: 'statusRow' },
          h('span', { className: 'statusLabel' }, '后端'),
          h('div', { className: 'statusValue' },
            connection.baseUrl
              ? h('a', {
                href: connection.baseUrl,
                target: '_blank',
                rel: 'noopener noreferrer',
                title: '在新标签页打开 Miloco 面板',
              }, connection.baseUrl)
              : h('code', null, '—'),
            h('span', { className: 'muted' }, `来源：${connection.source ?? '—'}`)),
          reachable
            ? h('span', { className: 'statusCheck', title: '已连通', 'aria-label': '已连通' }, '✓')
            : h('span', { className: 'statusCross', title: '连不上 Miloco', 'aria-label': '连不上' }, '✗')),
        h('div', { className: 'statusRow' },
          h('span', { className: 'statusLabel' }, '推送入口'),
          h('div', { className: 'statusValue' },
            h('code', null, push.path || '—'),
            h('span', { className: 'muted' }, push.tokenSet ? '推送令牌已配置' : '推送令牌未配置'),
            push.reusesBackendToken
              ? h('span', {
                className: 'pill warn',
                title: '推送令牌与后端令牌相同，任一处泄露会同时失守',
              }, '令牌与后端令牌相同 ⚠')
              : null),
          push.tokenSet
            ? h('span', { className: 'statusCheck', title: '推送令牌已配置', 'aria-label': '推送令牌已配置' }, '✓')
            : h('span', { className: 'statusCross', title: '没有推送令牌', 'aria-label': '没有推送令牌' }, '✗')),
        h('div', { className: 'statusRow' },
          h('span', { className: 'statusLabel' }, 'adapter'),
          h('div', { className: 'statusValue' },
            h('span', { className: 'muted' },
              adapter.installed
                ? `agent.platform=${adapter.agentPlatform || '未设置'}`
                : '安装 Miloco 后可一键写入 adapter 与令牌')),
          adapter.active
            ? h('span', { className: 'statusCheck', title: '已启用', 'aria-label': '已启用' }, '✓')
            : h('span', { className: `statusEnd pill ${adapter.installed ? 'warn' : 'bad'}` },
              adapter.installed ? '未启用' : '未安装')),
        h('div', { className: 'statusRow' },
          h('span', { className: 'statusLabel' }, '版本'),
          h('div', { className: 'statusValue' },
            h('code', {
              title: currentVersion || '未知',
            }, currentVersion ? currentVersion.split('+')[0] : '—'),
            commitShort ? h('span', { className: 'muted' }, commitShort) : null,
            h('span', { className: `pill ${versionPill[0]}` }, versionPill[1]),
            h('div', { className: 'versionSub' },
              latestVersion
                ? h('span', null, `最新正式版 ${latestVersion}`)
                : null,
              mirrorCheck
                ? h('span', {
                  className: 'muted',
                  title: 'GitHub 直连不可用，已通过镜像检查',
                }, '镜像')
                : null,
              releaseUrl
                ? h('a', {
                  href: releaseUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  title: '查看发布说明',
                }, '发布页')
                : null,
              isDevDeployment && devUpdateCommand
                ? h('button', {
                  type: 'button',
                  className: 'versionLink',
                  title: '查看源码部署的更新命令',
                  onClick: () => setVersionCommandOpen(!versionCommandOpen),
                }, versionCommandOpen ? '收起命令' : '手动更新')
                : null,
              h('button', {
                type: 'button',
                className: 'versionLink',
                title: '重新读取 Miloco 版本与更新状态',
                disabled: versionBusy,
                onClick: () => loadVersion(true),
              }, versionBusy ? '检查中…' : '检查更新'),
              upgradeUnavailable
                ? h('span', {
                  className: 'versionDirty',
                  title: upgradeInfo?.error || 'GitHub 与镜像均不可达',
                }, '更新检查不可用')
                : null,
              isDevDeployment && gitDirty
                ? h('span', {
                  className: 'versionDirty',
                  title: '源码工作区有本地改动，更新前请先处理或提交',
                }, '工作区有改动')
                : null,
              versionError
                ? h('span', { className: 'versionDirty', title: versionError }, '版本读取失败')
                : null,
              upgradePhase && !['idle', 'done', 'failed'].includes(upgradePhase)
                ? h('span', null, `升级中：${upgradePhaseLabels[upgradePhase] || upgradePhase}`)
                : null)),
          hasUpdate && !isDevDeployment
            ? h('div', { className: 'statusEnd' },
              h('button', {
                type: 'button',
                className: 'primary',
                disabled: upgradeBusy,
                onClick: () => setUpgradeConfirmOpen(!upgradeConfirmOpen),
              }, upgradeConfirmOpen ? '收起' : '更新'))
            : null),
        isDevDeployment && devUpdateCommand && versionCommandOpen
          ? h('div', { className: 'versionManualPanel' },
            h('code', { className: 'versionCommand' }, devUpdateCommand),
            h('div', { className: 'row' },
              h('button', {
                type: 'button',
                onClick: () => {
                  try { void navigator.clipboard?.writeText(devUpdateCommand) } catch { /* ignore */ }
                },
              }, '复制命令')))
          : null,
        upgradePhase === 'failed'
          ? h('div', { className: 'muted versionNote' }, `上次升级失败${upgradeLogPath ? `，可查看 ${upgradeLogPath}` : '，可查看 Miloco 的 upgrade.log'} 后重试。`)
          : null,
        upgradeConfirmOpen
          ? h('div', { className: 'danger' },
            h('h4', null, '更新 Miloco'),
            h('div', { className: 'muted' },
              '升级会短暂中断感知与自动化，完成后 Miloco 会自动重启。'),
            h('div', { className: 'row' },
              h('button', { type: 'button', onClick: () => setUpgradeConfirmOpen(false) }, '取消'),
              h('button', {
                type: 'button',
                className: 'primary',
                disabled: upgradeBusy,
                onClick: runUpgrade,
              }, upgradeBusy ? '启动中…' : '确认更新')))
          : null,
        upgradePolling
          ? h('div', { className: 'muted versionNote' }, '正在等待升级完成…')
          : null,
        h('div', { className: 'statusRow' },
          h('span', { className: 'statusLabel' }, '配置位置'),
          h('div', { className: 'statusValue' },
            h('code', { title: '当前生效的插件配置' }, status.configLocation?.effective ?? '—'))),
        h('div', { className: 'row' },
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: () => {
              const opening = !connectOpen
              setConnectOpen(opening)
              if (opening) setUninstallOpen(false)
            },
          }, '修改连接'),
          h('button', {
            type: 'button',
            className: 'dangerBtn',
            disabled: uninstallBusy,
            onClick: () => {
              const opening = !uninstallOpen
              setUninstallOpen(opening)
              if (opening) setConnectOpen(false)
            },
          }, '卸载 Miloco')),
        reachable ? connectForm : null,
        uninstallResult ? h('div', { className: 'muted' }, uninstallResult) : null,
        uninstallOpen
          ? h('div', { className: 'danger' },
            h('h4', null, '卸载 Miloco'),
            h('div', { className: 'muted' },
              '会停止 Miloco 服务、移除 DSH 侧 adapter，并清空本插件的连接与推送令牌。'),
            h('label', null,
              h('input', {
                type: 'checkbox', checked: removeSource,
                onChange: (event) => setRemoveSource(event.target.checked),
              }),
              h('span', null, `删除源码目录：${deployState.sourceDir || '（未知）'}`)),
            h('label', null,
              h('input', {
                type: 'checkbox', checked: removeData,
                onChange: (event) => setRemoveData(event.target.checked),
              }),
              h('span', null,
                `删除 Miloco 数据目录：${deployState.milocoHome || '（未知）'}`
                + '（账号绑定、数据库、感知记录，不可恢复）')),
            h('div', { className: 'row' },
              h('input', {
                type: 'text', value: confirmText, placeholder: '输入 UNINSTALL 确认',
                onChange: (event) => setConfirmText(event.target.value),
              }),
              h('button', {
                type: 'button',
                onClick: () => { setUninstallOpen(false); setConfirmText('') },
              }, '取消'),
              h('button', {
                type: 'button',
                className: 'dangerBtn',
                disabled: uninstallBusy || confirmText !== 'UNINSTALL',
                onClick: uninstall,
              }, uninstallBusy ? '卸载中…' : '确认卸载')))
          : null))

      // 运行状态固定排在第二格（未连接时在部署卡之后）。
      const order = ['deploy', 'runtime', 'workspace', 'mode', 'guide', 'target']
      cards.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))

      return h('div', { className: 'dsh-miloco-bridge-settings' }, cards)
    }

    /* ================================================================
     * 「Miloco 家庭助手」侧栏入口 + 专属工作区面板 + 折叠推送卡片
     * ================================================================ */

    /** Sidebar row id and main panel key share one identity. */
    const PANEL_ID = 'miloco'

    /** Message source kind carried by an inbound Miloco push. */
    const PUSH_SOURCE_KIND = 'miloco-push'

    /** Agent preset the Miloco conversations run with. */
    const AGENT_PRESET = 'miloco'

    /** Stable DOM id counter for the push card's disclosure body. */
    let pushBodySeq = 0

    /**
     * Read the plain text of a message's content blocks.
     * @param {any} content - ContentBlock list of a user message.
     * @returns {string} The joined text blocks.
     */
    function contentText(content) {
      if (!Array.isArray(content)) return ''
      return content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n')
    }

    /**
     * First non-empty line of a text blob.
     * @param {string} text - Source text.
     * @returns {string} The trimmed first line, or an empty string.
     */
    function firstLine(text) {
      const line = String(text ?? '')
        .split('\n')
        .map(part => part.trim())
        .find(part => part.length > 0)
      return line ?? ''
    }

    /**
     * Short display form of a Miloco version.
     * @param {any} value - Version string.
     * @returns {string} The stable part, or ''.
     */
    function formatShortVersion(value) {
      const text = String(value ?? '').trim()
      if (!text) return ''
      return text.split('+')[0].replace(/\.(post|dev|rc)\d*.*$/, '')
    }

    /**
     * Compact local message clock, matching DSH's message chrome.
     * @param {any} value - ISO string, epoch millis, or Date.
     * @param {number} [now] - Reference instant.
     * @returns {string} Local clock, or an empty string for an invalid instant.
     */
    function formatMessageClock(value, now = Date.now()) {
      if (value === undefined || value === null || value === '') return ''
      const date = value instanceof Date ? value : new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const reference = new Date(now)
      const pad = part => String(part).padStart(2, '0')
      const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
      if (date.getFullYear() === reference.getFullYear()
        && date.getMonth() === reference.getMonth()
        && date.getDate() === reference.getDate()) return clock
      const md = `${date.getMonth() + 1}月${date.getDate()}日`
      return date.getFullYear() === reference.getFullYear()
        ? `${md} ${clock}`
        : `${date.getFullYear()}年${md} ${clock}`
    }

    /**
     * Event time from the overview's normalised field, or the raw backend names.
     * @param {any} item - Event row.
     * @returns {string} The formatted clock, or ''.
     */
    function eventClock(item) {
      const raw = item?.timestamp ?? item?.ts ?? item?.created_at ?? item?.time
      if (typeof raw === 'number') return formatMessageClock(raw < 1e12 ? raw * 1000 : raw)
      return formatMessageClock(raw)
    }

    /**
     * Event label from the overview's normalised field, or the raw names.
     * @param {any} item - Event row.
     * @returns {string} The event label.
     */
    function eventKind(item) {
      return String(item?.kind ?? item?.type ?? item?.event_type ?? '事件')
    }

    /**
     * Event source from the overview's normalised field, or the raw names.
     * @param {any} item - Event row.
     * @returns {string} The source label.
     */
    function eventSource(item) {
      return String(item?.source ?? item?.device_name ?? item?.did ?? '—')
    }

    /**
     * Event one-line text from the overview's normalised field.
     * @param {any} item - Event row.
     * @returns {string} The summary, or ''.
     */
    function eventSummary(item) {
      return String(item?.summary ?? '').trim()
    }

    /**
     * Event urgency chip label, when the row carries one.
     * @param {any} item - Event row.
     * @returns {string} `高` / `中` / `低`, or '' when absent.
     */
    function eventPriority(item) {
      const value = String(item?.priority ?? '').trim().toLowerCase()
      return value === 'high' ? '高' : value === 'medium' ? '中' : value === 'low' ? '低' : ''
    }

    /**
     * The sidebar row glyph: a house outline drawn at the requested edge.
     * The sidebar owns the row, its label, and the selected state, so the
     * glyph only inherits the row's color, exactly like the shipped panels.
     * @param {{size?: number, active?: boolean}} props - Sidebar icon share.
     * @returns {any} The SVG element.
     */
    function MilocoPanelIcon(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M3.6 10.4 12 4l8.4 6.4' }),
      h('path', { d: 'M5.6 9.3V19a1 1 0 0 0 1 1h10.8a1 1 0 0 0 1-1V9.3' }),
      h('path', { d: 'M9.6 20v-4.6h4.8V20' }))
    }

    /**
     * The push card's source glyph: an external event (webhook family).
     * @param {number} size - Requested square edge.
     * @returns {any} The SVG element.
     */
    function MilocoPushSourceIcon(size) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('circle', { cx: 12, cy: 12, r: 8.4 }),
      h('path', { d: 'M3.6 12h16.8' }),
      h('path', { d: 'M12 3.6c2.6 2.4 2.6 14.4 0 16.8' }),
      h('path', { d: 'M12 3.6c-2.6 2.4-2.6 14.4 0 16.8' }))
    }

    /**
     * The push card's chevron.
     * @param {number} size - Requested square edge.
     * @returns {any} The SVG element.
     */
    function MilocoPushChevronIcon(size) {
      return h('svg', {
        viewBox: '0 0 24 24',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M6 9.5 12 15.5 18 9.5' }))
    }

    /**
     * Keep the last lines of a log for a compact preview.
     * @param {string} text - The full log.
     * @param {number} count - How many lines to keep.
     * @returns {string} The tail.
     */
    function tailLines(text, count) {
      const lines = String(text ?? '').split('\n').filter(line => line.trim() !== '')
      return lines.slice(-count).join('\n')
    }

    /**
     * Decide which view the household page shows.
     *
     * The dashboard is only for a working installation: an unconfigured one
     * gets its own centred onboarding page, a failed request gets its own
     * error page, and the very first render is a bare loading state. All
     * three are separate pages — none of them reuses the dashboard layout.
     *
     * @param {any} overview - The last `/home/overview` payload, or null.
     * @param {any} error - The last request error, or null.
     * @returns {{kind: 'loading'|'error'|'setup'|'dashboard', error?: string}} The page kind.
     */
    function milocoPanelState(overview, error) {
      if (!overview && !error) return { kind: 'loading' }
      if (error && !overview) {
        return { kind: 'error', error: String(error) || '读取失败' }
      }
      const status = overview?.status ?? null
      const setup = overview?.setup ?? null
      // Older hosts answer without the `setup` block: fall back to the
      // reachability and the account state the overview already reports.
      const reachable = setup
        ? Boolean(setup.connection?.reachable)
        : Boolean(status?.ok)
      const bound = setup
        ? Boolean(setup.account?.bound ?? setup.accountBound)
        : Boolean(status?.accountBound)
      // A reachable backend without a bound account is still "not set up":
      // the household overview would be empty without a household.
      if (!reachable || !bound) return { kind: 'setup' }
      return { kind: 'dashboard' }
    }

    /**
     * The centred loading state.
     * @param {any} [modal] - The configuration modal, rendered inside the page.
     * @returns {any} The element.
     */
    function milocoLoadingPage(modal) {
      return h('div', { className: 'dsh-miloco-dash-state' },
        h('div', { className: 'dsh-miloco-dash-spinner', 'aria-hidden': 'true' }),
        h('div', { className: 'dsh-miloco-dash-state-sub' }, '正在读取家庭概览…'),
        modal ?? null)
    }

    /**
     * The centred error state.
     * @param {string} error - The failure reason.
     * @param {() => void} onRetry - Reload the overview.
     * @param {() => void} onConfig - Open the configuration modal.
     * @param {any} [modal] - The configuration modal, rendered inside the page.
     * @returns {any} The element.
     */
    function milocoErrorPage(error, onRetry, onConfig, modal) {
      return h('div', { className: 'dsh-miloco-dash-state' },
        h('div', { className: 'dsh-miloco-dash-state-card' },
          h('div', { className: 'dsh-miloco-dash-state-mark' }, MilocoPanelIcon({ size: 22 })),
          h('div', { className: 'dsh-miloco-dash-state-title' }, '家庭助手暂时读不到数据'),
          h('div', { className: 'dsh-miloco-dash-state-error' }, error),
          h('div', { className: 'dsh-miloco-dash-state-actions' },
            h('button', { type: 'button', className: 'primary', onClick: onRetry }, '重试'),
            h('button', { type: 'button', onClick: onConfig }, '打开配置'))),
        modal ?? null)
    }

    /**
     * One-click Miloco deployment, inline in the onboarding page.
     *
     * The onboarding page is the first thing a new installation sees, so the
     * deploy action belongs here instead of behind the configuration menu.
     *
     * @param {{onDone?: () => void, failed?: boolean}} props - Component props.
     * @returns {any} The element.
     */
    function MilocoDeployBox(props) {
      const onDone = props?.onDone
      const [busy, setBusy] = React.useState(false)
      const [log, setLog] = React.useState('')
      const [error, setError] = React.useState('')

      const poll = () => {
        call('/deploy')
          .then((payload) => {
            setLog(String(payload?.log ?? ''))
            if (payload?.state?.running) {
              window.setTimeout(poll, 2_000)
              return
            }
            setBusy(false)
            onDone?.()
          })
          .catch((cause) => {
            setBusy(false)
            setError(cause instanceof Error ? cause.message : String(cause))
          })
      }

      const start = () => {
        setBusy(true)
        setError('')
        setLog('')
        call('/deploy', { method: 'POST' })
          .then((payload) => {
            if (!payload?.started) {
              setBusy(false)
              setError(payload?.reason ?? '部署未启动')
              return
            }
            poll()
          })
          .catch((cause) => {
            setBusy(false)
            setError(cause instanceof Error ? cause.message : String(cause))
          })
      }

      return h('div', null,
        h('div', { className: 'dsh-miloco-dash-actions' },
          h('button', {
            type: 'button', className: 'primary', disabled: busy, onClick: start,
          }, busy ? '部署中…' : (props?.failed ? '重试部署' : '一键部署 Miloco'))),
        error ? h('div', { className: 'dsh-miloco-dash-state-error' }, error) : null,
        log ? h('pre', { className: 'dsh-miloco-dash-log' }, tailLines(log, 12)) : null)
    }

    /**
     * Connect an already installed Miloco, inline in the onboarding page.
     *
     * Empty token fields keep the stored value, so opening the form and
     * confirming never wipes a working credential.
     *
     * @param {{onDone?: () => void}} props - Component props.
     * @returns {any} The element.
     */
    function MilocoConnectBox(props) {
      const onDone = props?.onDone
      const [url, setUrl] = React.useState('')
      const [token, setToken] = React.useState('')
      const [pushToken, setPushToken] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')

      const submit = () => {
        if (!url.trim()) {
          setError('请填写 Miloco 地址')
          return
        }
        setBusy(true)
        setError('')
        call('/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            baseUrl: url.trim(),
            token: token.trim(),
            pushToken: pushToken.trim(),
          }),
        })
          .then((payload) => {
            setNote(payload?.note ?? '已保存连接信息')
            onDone?.()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }

      return h('div', { className: 'dsh-miloco-dash-connect' },
        h('div', { className: 'dsh-miloco-dash-connect-row' },
          h('input', {
            type: 'text', value: url, placeholder: 'http://127.0.0.1:1810',
            onChange: (event) => setUrl(event.target.value),
          })),
        h('div', { className: 'dsh-miloco-dash-connect-row' },
          h('input', {
            type: 'password', value: token, placeholder: '后端令牌（DSH → Miloco，可留空）',
            onChange: (event) => setToken(event.target.value),
          })),
        h('div', { className: 'dsh-miloco-dash-connect-row' },
          h('input', {
            type: 'password', value: pushToken, placeholder: '推送令牌（Miloco → DSH，留空 = 沿用）',
            onChange: (event) => setPushToken(event.target.value),
          })),
        h('div', { className: 'dsh-miloco-dash-actions' },
          h('button', {
            type: 'button', className: 'primary', disabled: busy || !url.trim(), onClick: submit,
          }, busy ? '连接中…' : '连接'),
          note ? h('span', { className: 'dsh-miloco-dash-bind-ok' }, note) : null),
        error ? h('div', { className: 'dsh-miloco-dash-state-error' }, error) : null)
    }

    /**
     * The deploy / connect card of the settings tab.
     *
     * Three states share one card: a running deployment (progress), a failed
     * one (reason plus a retry), and a plain unreachable backend.
     *
     * @param {any} props - Component props.
     * @returns {any} The element.
     */
    function MilocoDeployCard(props) {
      const deployState = props?.deployState ?? {}
      const deployLog = String(props?.deployLog ?? '')
      const stepLabels = props?.deployStepLabels ?? {}
      const busy = Boolean(props?.busy)
      const deploying = Boolean(props?.deploying ?? deployState.running)
      const failed = Boolean(deployState.error)
      const done = deployState.step === 'done'
      return h('div', { className: 'card' },
        h('h3', null, deploying ? '正在部署 Miloco' : (failed ? '部署失败' : 'Miloco 尚未连接')),
        deploying
          ? h('div', { className: 'muted' },
            `安装器正在工作（${stepLabels[deployState.step] || deployState.step || '进行中'}）。`
            + '完成之前后端还连不上，这是正常的。')
          : failed
            ? h('div', { className: 'muted' },
              `安装器没有跑完：${deployState.error}。通常是下载中断，重试一次即可。`)
            : h('div', { className: 'muted' },
              props?.backendError || `连不上 ${props?.baseUrl || '（未配置地址）'}。`
              + '插件本身可以独立安装；部署或连接之后才会出现设备与感知能力。'),
        h('div', { className: 'muted' },
          '一键部署会下载官方 release 安装器（支持 GitHub 镜像），不会在本机编译源码。'),
        // The log is only worth the space while something is going on; a
        // finished deployment keeps the page readable.
        deployLog && !done
          ? h('pre', { className: 'dsh-miloco-deploy-log' }, deployLog)
          : null,
        h('div', { className: 'row' },
          h('button', {
            type: 'button',
            className: 'primary',
            disabled: busy || deploying,
            onClick: props?.onDeploy,
          }, busy || deploying ? '部署中…' : (failed ? '重试部署' : '一键部署 Miloco')),
          h('button', {
            type: 'button',
            disabled: busy,
            onClick: props?.onConnect,
          }, '连接已有的 Miloco')))
    }

    /**
     * The centred onboarding page for an installation that cannot reach
     * Miloco yet. It lists the three setup steps and their state instead of
     * pretending to be a configured household.
     * @param {any} overview - The `/home/overview` payload.
     * @param {() => void} onConfig - Open the configuration modal.
     * @param {() => void} onReload - Re-read the overview.
     * @param {any} [modal] - The configuration modal, rendered inside the page.
     * @returns {any} The element.
     */
    function milocoSetupPage(overview, onConfig, onReload, modal) {
      const setup = overview?.setup ?? null
      const status = overview?.status ?? null
      const push = overview?.push ?? null
      const connection = setup?.connection ?? {}
      const account = setup?.account ?? {}
      const reachable = setup
        ? Boolean(connection.reachable)
        : Boolean(status?.ok)
      const bound = setup
        ? Boolean(account.bound ?? setup.accountBound)
        : Boolean(status?.accountBound)
      const milocoUrl = String(setup?.milocoUrl ?? connection.baseUrl ?? '').trim()
      const installed = setup ? setup.milocoInstalled !== false : true
      // A running deployment is the reason the backend is unreachable: show
      // its progress instead of a connection error.
      const deploying = Boolean(setup?.deploy?.running)
      const deployLog = String(setup?.deploy?.log ?? '')
      const deployError = String(setup?.deploy?.error ?? '')
      const deployState = setup?.deploy ?? {}
      const steps = [
        {
          id: 'connection',
          done: reachable,
          title: '部署或连接 Miloco',
          hint: installed
            ? (connection.baseUrl
              ? `当前地址：${connection.baseUrl}`
              : '还没有填写连接地址')
            : '本机还没有安装 Miloco',
        },
        {
          id: 'account',
          done: bound,
          title: '绑定米家账号',
          hint: bound
            ? `已绑定${account.nickname ? `：${account.nickname}` : ''}`
            : '在 Miloco 里登录米家账号，才能看到家里的设备',
        },
        {
          id: 'push',
          done: Boolean(setup?.pushTokenSet ?? push?.tokenSet),
          title: '接收 Miloco 推送',
          hint: Boolean(setup?.pushTokenSet ?? push?.tokenSet)
            ? (setup?.pushTokenReusesBackend ? '令牌与后端令牌相同，建议重新生成' : '令牌：Miloco → DSH')
            : '生成推送令牌：Miloco → DSH',
        },
      ]
      return h('div', { className: 'dsh-miloco-dash-state' },
        h('div', { className: 'dsh-miloco-dash-state-card' },
          h('div', { className: 'dsh-miloco-dash-state-mark' }, MilocoPanelIcon({ size: 22 })),
          h('div', { className: 'dsh-miloco-dash-state-title' },
            deploying
              ? '正在部署 Miloco'
              : deployError
                ? '部署失败'
                : (installed ? '家庭助手还没有初始化' : '本机还没有 Miloco')),
          h('div', { className: 'dsh-miloco-dash-state-sub' },
            deploying
              ? '安装器正在下载并安装 Miloco。完成之前后端还连不上，这是正常的；'
                + '装好之后这一页会自动变成家庭概览。'
              : deployError
                ? '安装器没有跑完。展开下面的日志能看到失败原因，通常是下载中断，'
                  + '重试一次即可。'
                : reachable
                  ? 'Miloco 已经连上，但还没有绑定米家账号。绑定之后，这一页会变成家庭概览：'
                    + '设备、房间、感知事件与推送记录。'
                  : installed
                    ? '家庭助手需要一个能连上的 Miloco 后端。完成下面三步之后，'
                      + '这一页会变成家庭概览：设备、房间、感知事件与推送记录。'
                    : '先部署一个 Miloco（或连接一个已经装好的），它负责看摄像头、下发规则；'
                      + 'DSH 这一侧负责接收它的推送并交给家庭助手处理。'),
          h('ul', { className: 'dsh-miloco-dash-steps' }, steps.map((step, index) => h('li', {
            key: step.title,
            className: `dsh-miloco-dash-step${step.done ? ' done' : ''}`,
          },
          h('span', { className: 'dsh-miloco-dash-step-mark', 'aria-hidden': 'true' },
            step.done ? '✓' : String(index + 1)),
          h('span', { className: 'dsh-miloco-dash-step-text' },
            h('strong', null, step.title),
            h('span', null, step.hint)),
          // The account step carries the binding actions: the recommended way
          // is Miloco's own page, the in-page flow is the fallback.
          step.id === 'account' && reachable && !bound
            ? h(MilocoBindBox, { milocoUrl, onBound: onReload })
            : null,
          // The first step carries the install/connect actions, so a new
          // installation never has to hunt for the configuration menu.
          step.id === 'connection' && !deploying && deployError
            ? h(MilocoDeployBox, { onDone: onReload, failed: true })
            : null,
          step.id === 'connection' && !reachable && !deploying && !deployError
            ? (installed
              ? h(MilocoConnectBox, { onDone: onReload })
              : h(MilocoDeployBox, { onDone: onReload }))
            : null))),
          // The log is only worth the space while something is going on.
          deployLog && deployState?.step !== 'done'
            ? h('pre', { className: 'dsh-miloco-dash-log' }, tailLines(deployLog, 12))
            : null,
          !deploying && deployError
            ? h('div', { className: 'dsh-miloco-dash-state-error' }, `部署失败：${deployError}`)
            : null,
          setup?.error && installed && !deploying && !deployError
            ? h('div', { className: 'dsh-miloco-dash-state-error' }, setup.error)
            : null,
          h('div', { className: 'dsh-miloco-dash-state-actions' },
            deploying
              ? h('span', { className: 'muted' }, '部署进行中，完成后会自动刷新…')
              : null,
            h('button', { type: 'button', className: 'dsh-miloco-dash-link', onClick: onConfig }, '更多设置'),
            h('button', { type: 'button', onClick: onReload }, '重新检测'))),        h('div', { className: 'dsh-miloco-dash-note' },
          '隐私说明：本插件只与本机 Miloco 通信，不会把账号、令牌或家庭数据上传到任何第三方；'
          + '绑定建议优先在 Miloco 自己的页面完成。'),
        modal ?? null)
    }

    /**
     * The account binding actions of the onboarding page.
     *
     * Two ways, in the order the user should prefer them:
     * 1. open Miloco's own page (its account dialog does the whole flow);
     * 2. do it here — fetch the Xiaomi authorization link, let the user paste
     *    the payload the callback page shows, then hand it to Miloco.
     *
     * @param {{milocoUrl?: string, onBound?: () => void}} props - Component props.
     * @returns {any} The element.
     */
    function MilocoBindBox(props) {
      const milocoUrl = String(props?.milocoUrl ?? '').trim()
      const onBound = props?.onBound
      const [open, setOpen] = React.useState(false)
      const [oauthUrl, setOauthUrl] = React.useState('')
      const [payload, setPayload] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [done, setDone] = React.useState('')

      const fetchLink = () => {
        setBusy(true)
        setError('')
        call('/miot/bind', { method: 'POST' })
          .then((payload_) => {
            setOauthUrl(String(payload_?.oauthUrl ?? ''))
            if (!payload_?.oauthUrl) setError('Miloco 没有返回授权链接')
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }

      const submit = () => {
        if (!payload.trim()) {
          setError('请先粘贴小米回调页给出的内容')
          return
        }
        setBusy(true)
        setError('')
        call('/miot/authorize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload }),
        })
          .then(() => {
            setDone('绑定成功，正在刷新…（若设备为空，请在 Miloco 里选择家庭）')
            setPayload('')
            onBound?.()
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
          .finally(() => setBusy(false))
      }

      return h('div', { className: 'dsh-miloco-dash-bind' },
        h('div', { className: 'dsh-miloco-dash-bind-row' },
          milocoUrl
            ? h('a', {
              className: 'dsh-miloco-dash-extlink',
              href: milocoUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
            }, '在 Miloco 中绑定 ↗')
            : null,
          h('button', {
            type: 'button',
            className: 'dsh-miloco-dash-link',
            onClick: () => setOpen(!open),
          }, open ? '收起本页绑定' : '或在本页绑定')),
        open
          ? h('div', null,
            h('ol', { className: 'dsh-miloco-dash-bind-steps' },
              h('li', null,
                h('button', {
                  type: 'button',
                  className: 'dsh-miloco-dash-bind-btn',
                  disabled: busy,
                  onClick: fetchLink,
                }, busy && !oauthUrl ? '获取中…' : '① 获取小米授权链接'),
                oauthUrl
                  ? h('a', {
                    className: 'dsh-miloco-dash-extlink',
                    href: oauthUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, '打开小米授权页 ↗')
                  : null),
              h('li', null,
                h('div', null, '② 粘贴小米回调页给出的整段内容'),
                h('div', { className: 'dsh-miloco-dash-bind-hint' },
                  '① 只点一次：重新获取授权链接会让刚才复制的内容失效。'),
                h('textarea', {
                  className: 'dsh-miloco-dash-bind-input',
                  value: payload,
                  placeholder: '回调页上的授权内容',
                  onChange: (event) => setPayload(event.target.value),
                })),
              h('li', null,
                h('button', {
                  type: 'button',
                  className: 'dsh-miloco-dash-bind-btn',
                  disabled: busy,
                  onClick: submit,
                }, busy ? '绑定中…' : '③ 完成绑定'))),
            done ? h('div', { className: 'dsh-miloco-dash-bind-ok' }, done) : null,
            error ? h('div', { className: 'dsh-miloco-dash-state-error' }, error) : null)
          : null)
    }

    /**
     * Build the 「Miloco 家庭助手」 main panel bound to one plugin context.
     * The panel is a read-only household overview: workspace path and state,
     * devices by room, recent events, and recent pushes. Session management
     * (pin/rename/archive) deliberately lives nowhere else.
     * @param {any} ctx - Browser plugin context.
     * @returns {Function} The panel component.
     */
    function createMilocoHomePanel(ctx) {
      function MilocoHomePanel() {
        const [overview, setOverview] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [configOpen, setConfigOpen] = React.useState(false)
        const inFlight = React.useRef(false)
        const mounted = React.useRef(false)

        const load = React.useCallback(() => {
          if (inFlight.current) return
          inFlight.current = true
          call('/home/overview')
            .then((payload) => {
              if (!mounted.current) return
              setOverview(payload)
              setError(null)
            })
            .catch((cause) => {
              if (!mounted.current) return
              setError(cause instanceof Error ? cause.message : String(cause))
            })
            .finally(() => {
              inFlight.current = false
            })
        }, [])

        React.useEffect(() => {
          mounted.current = true
          load()
          const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') load()
          }, 60_000)
          return () => {
            mounted.current = false
            window.clearInterval(timer)
          }
        }, [load])

        // While a deployment runs, poll faster: the page must switch to the
        // household overview on its own once the backend comes up.
        const deploying = Boolean(overview?.setup?.deploy?.running)
        React.useEffect(() => {
          if (!deploying) return undefined
          const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') load()
          }, 8_000)
          return () => window.clearInterval(timer)
        }, [deploying, load])

        React.useEffect(() => {
          if (!configOpen) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setConfigOpen(false)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [configOpen])

        // Host without `workspaceRegistry`: adopt the path through the public API
        // so the page still gets a workspace id. Idempotent for a known path.
        const adopting = React.useRef(false)
        React.useEffect(() => {
          const homeState = overview?.home
          if (!homeState?.path || homeState.workspaceId || adopting.current) return
          if (!ctx.workspaces || typeof ctx.workspaces.create !== 'function') return
          adopting.current = true
          ctx.workspaces.create({ path: homeState.path })
            .then(async (workspace) => {
              const workspaceId = workspace?.workspaceId ?? ''
              if (!workspaceId) return
              if (homeState.title && typeof ctx.workspaces.rename === 'function') {
                await ctx.workspaces.rename(workspaceId, homeState.title).catch(() => {})
              }
              if (typeof ctx.workspaces.insertBefore === 'function') {
                const list = ctx.workspaces.list
                const items = typeof list?.getSnapshot === 'function'
                  ? (list.getSnapshot()?.items ?? [])
                  : []
                const first = items.find(item => item?.workspaceId !== workspaceId)
                if (first) await ctx.workspaces.insertBefore(workspaceId, first.workspaceId).catch(() => {})
              }
              if (!mounted.current) return
              setOverview(previous => previous
                ? { ...previous, home: { ...previous.home, workspaceId } }
                : previous)
            })
            .catch((cause) => {
              if (mounted.current) {
                setError(`无法注册家庭工作区：${cause instanceof Error ? cause.message : String(cause)}`)
              }
            })
            .finally(() => { adopting.current = false })
        }, [overview?.home?.path, overview?.home?.workspaceId, overview?.home?.title])

        const home = overview?.home ?? null
        const status = overview?.status ?? null
        const version = overview?.version ?? null
        const devices = overview?.devices ?? null
        const events = overview?.events ?? null
        const pushes = overview?.pushes ?? null
        const push = overview?.push ?? null
        const stats = overview?.overview ?? null
        // 页面形态：加载中 / 读取失败 / 未配置 / 仪表盘，四种互斥。
        const view = milocoPanelState(overview, error)

        const startSession = () => {
          if (!home?.workspaceId) return
          try {
            ctx.uiWorkspace.startSession(home.workspaceId, {
              agentPreset: home.agentPreset || AGENT_PRESET,
            })
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }

        const openSession = (sessionId) => {
          if (typeof sessionId !== 'string' || !sessionId) return
          try {
            ctx.uiWorkspace.openSession(sessionId)
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause))
          }
        }

        const rooms = devices?.ok && Array.isArray(devices.rooms) ? devices.rooms : []
        const eventItems = events?.ok && Array.isArray(events.items) ? events.items : []
        const pushItems = pushes?.ok && Array.isArray(pushes.items) ? pushes.items.slice(0, 10) : []

        const sectionError = text => h('div', { className: 'dsh-miloco-dash-error' },
          h('span', null, text || '读取失败'),
          h('button', { type: 'button', className: 'dsh-miloco-dash-link', onClick: load }, '重试'))

        const chip = (key, tone, label, title) => h('span', {
          key,
          className: `dsh-miloco-dash-chip${tone ? ` ${tone}` : ''}`,
          title: title || undefined,
        },
        tone === 'ok' || tone === 'warn'
          ? h('i', { className: 'dsh-miloco-dash-chipdot', 'aria-hidden': 'true' })
          : null,
        h('span', null, label))

        const stat = (key, label, value, title) => h('div', { className: 'dsh-miloco-dash-stat', key },
          h('span', { className: 'k' }, label),
          h('span', { className: 'v', title: title || undefined }, value))

        const header = h('div', { className: 'dsh-miloco-dash-head' },
          h('div', { className: 'dsh-miloco-dash-head-main' },
            h('div', { className: 'dsh-miloco-dash-title' }, '家庭助手')),
          h('div', { className: 'dsh-miloco-dash-actions' },
            h('button', {
              type: 'button',
              className: 'primary',
              disabled: !home?.workspaceId,
              onClick: startSession,
            }, '新建家庭会话'),
            h('button', {
              type: 'button', className: 'dsh-miloco-dash-link', onClick: () => setConfigOpen(true),
            }, '配置')))

        // 配置弹层：仪表盘、初始化页、错误页共用同一个弹层。
        // 壳与原生设置面板一致：遮罩 + 800px 面板 + 右上角图标按钮。
        const configModal = configOpen
          ? h('div', { className: 'dsh-miloco-dash-config-backdrop' },
            h('div', {
              className: 'dsh-miloco-dash-config-mask',
              'aria-hidden': 'true',
              onClick: () => setConfigOpen(false),
            }),
            h('div', {
              className: 'dsh-miloco-dash-config',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': 'Miloco 配置',
            },
            h('div', { className: 'dsh-miloco-dash-config-head' },
              h('h3', null, 'Miloco 配置'),
              h('button', {
                type: 'button',
                className: 'dsh-miloco-dash-config-close',
                onClick: () => setConfigOpen(false),
                'aria-label': '关闭配置',
              }, h('svg', {
                viewBox: '0 0 14 14',
                width: 14,
                height: 14,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                'aria-hidden': 'true',
              }, h('path', { d: 'M3 3l8 8M11 3l-8 8' })))),
            h('div', { className: 'dsh-miloco-dash-config-body' }, h(MilocoSettingsTab))))
          : null

        // ---------------------------------------------------------------- 加载中
        // 加载中不渲染仪表盘头部：按钮此时还没有意义，页面只留一个居中的
        // 进度提示，避免「标题 + 按钮悬在顶上」的半成品样子。
        if (view.kind === 'loading') {
          return milocoLoadingPage(configModal)
        }

        // 整体请求失败（插件未加载、版本不匹配、服务端异常）时给一页独立的
        // 错误说明，而不是把空仪表盘铺在页面上。
        if (view.kind === 'error') {
          return milocoErrorPage(view.error, load, () => setConfigOpen(true), configModal)
        }

        // 没连上 Miloco 时，页面是一张独立的初始化引导，而不是「配好了」的
        // 仪表盘：两者信息量完全不同，不能共用一套布局。
        if (view.kind === 'setup') {
          return milocoSetupPage(overview, () => setConfigOpen(true), load, configModal)
        }

        return h('div', { className: 'dsh-miloco-dash' },
          header,

          error ? sectionError(error) : null,

          h('section', { className: 'dsh-miloco-dash-card dsh-miloco-dash-summary' },
            h('div', { className: 'dsh-miloco-dash-card-head' },
              h('div', { className: 'dsh-miloco-dash-card-title' },
                h('h3', null, '家庭概览'),
                status?.perceptionRunning
                  ? h('span', { className: 'dsh-miloco-dash-meta' }, '感知运行中')
                  : null)),
            h('div', { className: 'dsh-miloco-dash-chips' },
            chip('status', status?.reachable ? 'ok' : 'warn',
              status?.ok ? (status.reachable ? '已连接' : '未连接') : '状态不可用'),
            version?.current
              ? chip('version', '', `v${formatShortVersion(version.current)}`, version.current)
              : null,
            version?.hasUpdate ? chip('update', 'warn', '有更新') : null,
            status?.accountBound
              ? chip('account', '', '账号已绑定', status.account?.nickname || '')
              : chip('account', 'warn', '账号未绑定'),
            push
              ? chip('push', push.tokenSet ? 'ok' : 'warn',
                push.tokenSet ? '推送已启用' : '推送未配置', push.path)
              : null),
            h('div', { className: 'dsh-miloco-dash-stats' },
              stat('account', '米家账号',
                stats?.account?.nickname || (stats?.accountBound ? '已绑定' : '未绑定'),
                stats?.account?.nickname || ''),
              stat('devices', '设备', stats?.deviceCount ?? '—'),
              stat('cameras', '摄像头', stats?.cameraCount ?? '—'),
              stat('rules', '规则 / 任务', `${stats?.ruleCount ?? '—'} / ${stats?.taskCount ?? '—'}`),
              stat('engine', '感知引擎', stats?.perceptionRunning ? '运行中' : '未运行'),
              stat('sources', '感知源', stats?.perceptionSources ?? '—'),
              stat('tokenEvents', 'token 记录', stats?.tokenEvents ?? '—'),
              stat('tokenTotal', 'token 合计', stats?.tokenTotal ?? '—'))),

          h('section', { className: 'dsh-miloco-dash-card' },
            h('div', { className: 'dsh-miloco-dash-card-head' },
              h('div', { className: 'dsh-miloco-dash-card-title' },
                h('h3', null, '设备与房间'),
                devices?.ok
                  ? h('span', { className: 'dsh-miloco-dash-meta' },
                    `${rooms.length} 个房间 · ${devices.total} 台设备`)
                  : null),
              devices?.ok
                ? h('span', { className: 'dsh-miloco-dash-score' }, `${devices.online} 在线`)
                : null),
            devices?.ok
              ? (rooms.length > 0
                ? h('div', { className: 'dsh-miloco-dash-rooms' }, rooms.map(room => h('details', { className: 'dsh-miloco-dash-room', key: room.name },
                  h('summary', { className: 'dsh-miloco-dash-room-head' },
                    h('span', { className: 'dsh-miloco-dash-room-name' }, room.name),
                    h('span', {
                      className: `dsh-miloco-dash-room-count${room.online === room.total ? ' ok' : room.online === 0 ? ' off' : ''}`,
                    }, `${room.online}/${room.total}`),
                    h('span', { className: 'dsh-miloco-dash-room-bar', 'aria-hidden': 'true' },
                      h('i', {
                        style: { width: `${room.total ? Math.round((room.online / room.total) * 100) : 0}%` },
                      })),
                    h('span', { className: 'dsh-miloco-dash-chev', 'aria-hidden': 'true' }, '›')),
                  h('ul', { className: 'dsh-miloco-dash-list' }, (room.devices ?? []).map((device, index) => h('li', {
                    key: device.did || device.name || String(index),
                    className: 'dsh-miloco-dash-row',
                  },
                  h('span', {
                    className: `dsh-miloco-dash-devdot${device.online ? ' ok' : ''}`,
                    'aria-hidden': 'true',
                  }),
                  h('span', { className: 'dsh-miloco-dash-main', title: device.name || device.did || undefined }, device.name || device.did || '未命名设备'),
                  device.online ? null : h('span', { className: 'dsh-miloco-dash-tag' }, '离线')))))))
                : h('div', { className: 'dsh-miloco-dash-empty' }, '没有设备'))
              : sectionError(devices?.error || '读取设备失败')),

          h('div', { className: 'dsh-miloco-dash-grid' },
            h('section', { className: 'dsh-miloco-dash-card' },
              h('div', { className: 'dsh-miloco-dash-card-head' },
                h('div', { className: 'dsh-miloco-dash-card-title' },
                  h('h3', null, '最近事件'),
                  events?.ok && eventItems.length > 0
                    ? h('span', { className: 'dsh-miloco-dash-meta' }, `${eventItems.length} 条`)
                    : null)),
              events?.ok
              ? (eventItems.length > 0
                ? h('ul', { className: 'dsh-miloco-dash-list' }, eventItems.map((item, index) => {
                  const summary = eventSummary(item)
                  const source = eventSource(item)
                  const priority = eventPriority(item)
                  return h('li', {
                    key: `${eventKind(item)}-${index}`,
                    className: 'dsh-miloco-dash-row',
                  },
                  h('span', {
                    className: 'dsh-miloco-dash-main',
                    title: summary && source ? `${source} · ${summary}` : summary || source || undefined,
                  }, summary || eventKind(item)),
                  priority ? h('span', { className: 'dsh-miloco-dash-tag' }, priority) : null,
                  h('span', { className: 'dsh-miloco-dash-meta' }, eventClock(item) || '—'))
                }))
                : h('div', { className: 'dsh-miloco-dash-empty' }, '最近没有事件'))
              : sectionError(events?.error || '读取事件失败')),

          h('section', { className: 'dsh-miloco-dash-card' },
              h('div', { className: 'dsh-miloco-dash-card-head' },
                h('div', { className: 'dsh-miloco-dash-card-title' },
                  h('h3', null, '推送记录'),
                  pushItems.length > 0
                    ? h('span', { className: 'dsh-miloco-dash-meta' }, `${pushItems.length} 条`)
                    : null),
                home?.archive?.exists
                  ? h('button', {
                    type: 'button',
                    className: 'dsh-miloco-dash-link dsh-miloco-dash-meta',
                    onClick: () => openSession(home.archive.sessionId),
                  }, '打开归档会话')
                  : null),
            pushes?.ok
              ? (pushItems.length > 0
                ? h('ul', { className: 'dsh-miloco-dash-list' }, pushItems.map((item, index) => h('li', {
                  key: item.runId || String(index),
                  className: 'dsh-miloco-dash-row',
                },
                h('button', {
                  type: 'button',
                  className: 'dsh-miloco-dash-link dsh-miloco-dash-main',
                  onClick: () => openSession(item.sessionId),
                }, item.title || item.summary || '推送'),
                h('span', { className: 'dsh-miloco-dash-meta' }, `${item.at ? formatMessageClock(item.at) : '—'}${item.status ? ` · ${item.status}` : ''}`))))
                : h('div', { className: 'dsh-miloco-dash-empty' }, '还没有推送记录'))
              : sectionError(pushes?.error || '读取推送失败'))),

          configModal)
      }

      return MilocoHomePanel
    }

    /**
     * The conversation Definition that claims an inbound Miloco push.
     *
     * `exclusive: true` claims the event on the `chat` target, so the
     * built-in non-exclusive `input-message` Definition never sees it and the
     * push is rendered exactly once, by our own renderer.
     */
    const milocoPushDefinition = {
      kind: PUSH_SOURCE_KIND,
      target: 'chat',
      match: (event) => {
        if (event?.type !== 'user/message') return null
        const source = event.data?.source
        if (source?.kind !== PUSH_SOURCE_KIND) return null
        return { id: String(event.data.id), role: 'start', exclusive: true }
      },
      start: (_context, match) => {
        const event = match.event
        const content = contentText(event.data?.content)
        const summary = typeof event.data?.source?.summary === 'string' ? event.data.source.summary : ''
        return {
          seq: event.seq,
          time: event.time,
          title: summary || firstLine(content) || 'Miloco 推送',
          summary,
          content,
        }
      },
      update: context => context.state,
      buildViewNode: (context) => {
        const state = context.state
        if (!state) return null
        const location = context.start?.location
          ?? context.matches[0]?.location
          ?? { kind: 'unresolved' }
        return {
          key: context.key,
          kind: PUSH_SOURCE_KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: state.seq,
          location,
          visibility: 'visible',
          groupTree: 'input',
          data: {
            title: state.title,
            summary: state.summary,
            time: state.time,
            content: state.content,
          },
        }
      },
    }

    /**
     * The collapsed push card. Its look copies DSH's scheduled-task trigger
     * notice: a rounded card with an icon, the push title, a local clock, and
     * a chevron; the detail body shows only after expanding.
     * @param {{node?: any}} props - The keyed Chat node renderer share.
     * @returns {any} The card element.
     */
    function MilocoPushNodeView(props) {
      const data = props?.node?.data ?? {}
      const [open, setOpen] = React.useState(false)
      const bodyId = React.useMemo(() => {
        pushBodySeq += 1
        return `dsh-miloco-push-body-${pushBodySeq}`
      }, [])
      const time = formatMessageClock(data.time)
      let iso = ''
      try {
        const date = data.time ? new Date(data.time) : null
        iso = date && !Number.isNaN(date.getTime()) ? date.toISOString() : ''
      } catch {
        iso = ''
      }
      return h('section', { className: 'dsh-miloco-push-root', 'data-miloco-push': '' },
        h('button', {
          className: 'dsh-miloco-push-header',
          type: 'button',
          'aria-expanded': open,
          'aria-controls': bodyId,
          onClick: () => setOpen(!open),
        },
        h('span', { className: 'dsh-miloco-push-icon', 'aria-hidden': 'true' }, MilocoPushSourceIcon(14)),
        h('span', { className: 'dsh-miloco-push-title' }, data.title || 'Miloco 推送'),
        time
          ? h('time', { className: 'dsh-miloco-push-time', dateTime: iso }, time)
          : null,
        h('span', {
          className: `dsh-miloco-push-chevron${open ? ' open' : ''}`,
          'aria-hidden': 'true',
        }, MilocoPushChevronIcon(12))),
        open
          ? h('div', { id: bodyId, className: 'dsh-miloco-push-body' },
            h('p', { className: 'dsh-miloco-push-explanation' }, '这条通知触发了本轮回复。'),
            h('div', { className: 'dsh-miloco-push-content' }, data.content || ''))
          : null)
    }

    function apply(ctx) {
      ensureStyles()
      installPresetGuide(ctx)

      // 配置入口在家庭助手页面（新建家庭会话右侧的「配置」按钮），不再注册
      // 内置「设置 → 插件」标签页。
      // 侧栏入口：面板列表的最后一行，正好在「更多」按钮的上一行。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 1000,
        label: () => 'Miloco 家庭助手',
      }, MilocoPanelIcon))

      // 同名 main 面板：没有它，点击侧栏行会抛错。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, createMilocoHomePanel(ctx)))

      // 折叠推送卡片：先认领事件，再渲染它。
      // 注册随本 fiber 的生命周期结束，卸载后不会留下重复的 kind。
      ctx.effect(() => {
        let dispose = null
        try {
          dispose = ctx.uiConversation.events.register(milocoPushDefinition)
        } catch {
          // 上一个实例已经占用这个 kind；沿用它即可。
          dispose = null
        }
        return () => { if (dispose) dispose() }
      }, 'dsh-miloco: push conversation definition')
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node',
        key: PUSH_SOURCE_KIND,
      }, MilocoPushNodeView))
    }

    exports.apply = apply
    exports.inject = inject
    exports.MilocoSettingsTab = MilocoSettingsTab
    exports.MilocoPanelIcon = MilocoPanelIcon
    exports.milocoPanelState = milocoPanelState
    exports.milocoLoadingPage = milocoLoadingPage
    exports.milocoErrorPage = milocoErrorPage
    exports.milocoSetupPage = milocoSetupPage
    exports.MilocoDeployCard = MilocoDeployCard
    exports.MilocoBindBox = MilocoBindBox
    exports.MilocoPushNodeView = MilocoPushNodeView
    exports.createMilocoHomePanel = createMilocoHomePanel
    exports.formatMessageClock = formatMessageClock
    exports.milocoPushDefinition = milocoPushDefinition
    exports.modelOptions = modelOptions
    exports.sessionOptions = sessionOptions
    exports.effortOptions = effortOptions
    return module.exports
  },
})
