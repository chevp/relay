/**
 * Context-menu logic on the relay side.
 *
 * On `contextmenu.request` from the player, build the action list as synth-XML
 * and send it back via the `showContextMenu` RPC. On `menu.action`, run the
 * actual action logic (this is where event processing lives, per design).
 *
 * The menu is context-dependent: a different action set is offered when an
 * entity is under the cursor (entity picking is a player-side follow-up; until
 * then `entity` is always "").
 */

import type WebSocket from 'ws';
import { sendCmd } from './ipc.js';
import type { DaemonEvent } from './events.js';

const SYNTH_NS = 'https://chevp.github.io/synth-protocol/schema/synth/1.0';

/** Escape a string for safe inclusion in an XML attribute value. */
function xmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build the `<synth><context-menu>` document for a right-click request. */
export function buildMenuXml(req: { x: number; y: number; entity: string }): string {
  const e = req.entity;
  const items = e
    ? `
    <action id="inspect" label="${xmlAttr(`Inspect ${e}`)}" event="entity.inspect"/>
    <action id="focus"   label="Focus Camera" event="camera.focus"/>
    <separator/>
    <submenu label="Transform">
      <action id="reset-pos" label="Reset Position" event="entity.resetPos"/>
      <action id="reset-rot" label="Reset Rotation" event="entity.resetRot"/>
    </submenu>
    <separator/>
    <action id="delete"  label="Delete" event="entity.delete" danger="true"/>`
    : `
    <action id="add"   label="Add Entity…" event="scene.add"/>
    <action id="paste" label="Paste"       event="clipboard.paste"/>`;

  return `<synth xmlns="${SYNTH_NS}">
  <context-menu x="${Math.round(req.x)}" y="${Math.round(req.y)}" entity="${xmlAttr(e)}">${items}
  </context-menu>
</synth>`;
}

/**
 * Process a daemon push-event. For `contextmenu.request`, reply with the menu;
 * for `menu.action`, run the action logic.
 */
export async function handleDaemonEvent(ev: DaemonEvent, ws: WebSocket): Promise<void> {
  if (ev.type === 'contextmenu.request') {
    const xml = buildMenuXml(ev);
    try {
      await sendCmd(ws, 'showContextMenu', { xml, x: ev.x, y: ev.y }, 5_000);
    } catch (err) {
      console.error(`[relay] showContextMenu failed: ${(err as Error).message}`);
    }
    return;
  }

  if (ev.type === 'menu.action') {
    // ── Event processing lives here (relay/kosmos side) ──────────────────
    // v1: log. Later: dispatch ev.event to engine RPCs (setCamera, loadScene,
    // custom commands) or kosmos services.
    console.log(
      `[relay] menu.action: action=${ev.action} event=${ev.event}` +
        `${ev.param ? ` param=${ev.param}` : ''} entity=${ev.entity || '-'}`,
    );
    return;
  }
}
