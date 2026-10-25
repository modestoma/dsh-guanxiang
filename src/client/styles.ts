/**
 * 「观象」页面样式。使用 DSH 语义 token（`--dsw-alias-*`）并带中性回退，
 * 页面随当前主题变化。
 *
 * @module dsh-guanxiang/client/styles
 */

const STYLE_ATTRIBUTE = 'data-dsh-guanxiang-css'

const CSS = `
.gx-page{width:100%;height:100%;min-width:0;min-height:0;overflow:auto;scrollbar-gutter:stable;background:var(--dsw-alias-bg-base,#fff)}
.gx-page__content{box-sizing:border-box;max-width:816px;margin:0 auto;padding:18px clamp(24px,4vw,48px) 48px}
[data-platform='darwin'] .gx-page__content{padding-top:calc(18px + var(--dsh-frame-top-clearance,0px))}
.gx{--gx-fg:var(--dsw-alias-label-primary,#1f2328);--gx-fg2:var(--dsw-alias-label-secondary,#5c6169);--gx-fg3:var(--dsw-alias-label-tertiary,#8a8f98);--gx-dim:var(--dsw-alias-label-dimmed,#b0b4ba);--gx-bg:var(--dsw-alias-bg-base,#fff);--gx-line:var(--dsw-alias-border-l2,rgba(0,0,0,.12));--gx-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--gx-accent:var(--dsw-alias-state-business-primary,#0a67d3);--gx-ok:var(--dsw-alias-state-success-primary,#0a7d33);--gx-warn:var(--dsw-alias-state-warn-primary,#a15c00);--gx-bad:var(--dsw-alias-state-error-primary,#c62828);--gx-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;display:flex;flex-direction:column;gap:14px;width:100%;max-width:720px;color:var(--gx-fg);font-size:13px;line-height:20px}
.gx__head{position:sticky;top:0;z-index:2;display:flex;flex-direction:column;gap:4px;padding:10px 0 6px;background:var(--gx-bg)}
.gx__headRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.gx__title{margin:0 2px 0 0;font-size:20px;font-weight:500;line-height:28px}
.gx__meta{color:var(--gx-fg3);font-size:12px}
.gx__mono{font-family:var(--gx-mono);font-size:12px}
.gx__pill{display:inline-flex;align-items:center;gap:5px;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;white-space:nowrap;color:var(--gx-fg3);background:color-mix(in srgb,currentColor 10%,transparent)}
.gx__pill--ok{color:var(--gx-ok)}
.gx__pill--warn{color:var(--gx-warn)}
.gx__pill--bad{color:var(--gx-bad)}
.gx__dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
.gx__tabs{display:flex;align-items:center;gap:18px;border-bottom:1px solid var(--gx-line);overflow-x:auto;scrollbar-width:none}
.gx__tab{display:inline-flex;align-items:center;min-height:34px;padding:0;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--gx-fg2);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.gx__tab:hover{color:var(--gx-fg)}
.gx__tab[aria-selected="true"]{color:var(--gx-fg);border-bottom-color:currentColor;font-weight:600}
.gx__body{display:flex;flex-direction:column;gap:22px;padding:4px 0 8px}
.gx__sec{display:flex;flex-direction:column;gap:6px;margin:0}
.gx__secTitle{margin:0;font-size:12px;font-weight:600;line-height:18px;color:var(--gx-fg3);letter-spacing:.02em}
.gx__secFoot{margin:0;color:var(--gx-fg3);font-size:12px;line-height:18px}
.gx__list{display:flex;flex-direction:column;border:1px solid var(--gx-line);border-radius:10px}
.gx__list>*+*{border-top:1px solid var(--gx-line)}
.gx__row{display:flex;align-items:center;gap:16px;padding:11px 14px;min-height:28px}
.gx__row--top{align-items:flex-start}
.gx__rowText{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0}
.gx__rowLabel{display:flex;align-items:center;gap:6px;flex-wrap:wrap;overflow-wrap:anywhere}
.gx__rowSummary{color:var(--gx-fg3);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.gx__rowError{color:var(--gx-bad);font-size:12px;line-height:18px;overflow-wrap:anywhere;white-space:pre-wrap}
.gx__rowCtl{flex:none;display:flex;align-items:center;gap:6px;justify-content:flex-end}
.gx__tag{display:inline-flex;align-items:center;padding:0 5px;border-radius:4px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--gx-fg2);background:var(--gx-hover)}
.gx__tag--accent{color:var(--gx-accent);background:color-mix(in srgb,var(--gx-accent) 10%,transparent)}
.gx__input{box-sizing:border-box;width:100%;min-width:0;height:30px;padding:0 10px;border:1px solid var(--gx-line);border-radius:7px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:13px;outline:none}
.gx__input:focus{border-color:var(--gx-accent)}
.gx__input--num{width:120px;text-align:right;font-variant-numeric:tabular-nums}
.gx__input--wide{width:320px}
.gx__unit{min-width:36px;color:var(--gx-fg3);font-size:12px}
.gx__addRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px}
.gx__addRow .gx__input{flex:1 1 160px;width:auto}
.gx__addRow .gx__input--branch{flex:0 1 140px}
.gx__emptyRow{padding:11px 14px;color:var(--gx-fg3);font-size:12px}
.gx__btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 12px;border:1px solid var(--gx-line);border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.gx__btn:hover:not(:disabled){background:var(--gx-hover)}
.gx__btn:disabled{color:var(--gx-dim);cursor:default}
.gx__btn--primary{background:var(--dsw-alias-button-primary-fill,var(--gx-accent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.gx__btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,#0b5cba)}
.gx__btn--primary:disabled{opacity:.45;color:var(--dsw-alias-label-primary-foreground,#fff)}
.gx__btn--ghost{border-color:transparent;color:var(--gx-fg2)}
.gx__btn--danger{color:var(--gx-bad)}
.gx__btn:focus-visible,.gx__tab:focus-visible{outline:2px solid var(--gx-accent);outline-offset:2px}
.gx__notice{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;overflow-wrap:anywhere}
.gx__notice--ok{color:var(--gx-ok);background:color-mix(in srgb,var(--gx-ok) 9%,transparent)}
.gx__notice--error{color:var(--gx-bad);background:color-mix(in srgb,var(--gx-bad) 8%,transparent)}
.gx__saveBar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--gx-line);background:var(--gx-bg)}
.gx__saveMsg{flex:1;min-width:0;color:var(--gx-fg2);font-size:12px}
.gx__loading{padding:16px 0;color:var(--gx-fg3);font-size:12px}
`

/**
 * Install the page stylesheet once.
 * @returns disposer removing it.
 */
export function installStyles(): () => void {
  const existing = document.querySelector(`style[${STYLE_ATTRIBUTE}]`)
  if (existing !== null) return () => {}
  const element = document.createElement('style')
  element.setAttribute(STYLE_ATTRIBUTE, '')
  element.textContent = CSS
  document.head.append(element)
  return () => { element.remove() }
}
