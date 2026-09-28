import { SettingsManager } from "@earendil-works/pi-coding-agent";

type CapabilityGetter = SettingsManager["getTerminalCapabilityOverrides"];
type CapabilityOverrides = ReturnType<CapabilityGetter>;
type CapabilityBridge = { original: CapabilityGetter; getter: CapabilityGetter; owners: Set<symbol> };
const BRIDGE = Symbol.for("@each1024/pi-mini-mode/terminal-capabilities");

function terminalDefaults(overrides: CapabilityOverrides): CapabilityOverrides {
  const term = process.env.TERM?.toLowerCase() ?? "";
  if (process.env.TERM_PROGRAM?.toLowerCase() !== "otty" || process.env.TMUX || process.env.STY || /^(tmux|screen)/.test(term)) return overrides;
  const defaults: CapabilityOverrides = {};
  const protocol = process.env.PI_IMAGE_PROTOCOL?.toLowerCase();
  if (overrides.images === undefined && !["kitty", "iterm2", "none", "0"].includes(protocol ?? "")) defaults.images = "kitty";
  if (overrides.hyperlinks === undefined && !["0", "1"].includes(process.env.PI_HYPERLINKS ?? "")) defaults.hyperlinks = true;
  return Object.keys(defaults).length ? { ...overrides, ...defaults } : overrides;
}

/** Temporary bridge: Pi exposes settings overrides but no extension hook for detection defaults.
 * Install in the extension factory, before the host applies settings and starts its renderer.
 * Never infer why getCapabilities().images is null or override the renderer's restrictions.
 */
export function installTerminalCapabilities(): () => void {
  const prototype = SettingsManager.prototype as SettingsManager & { [BRIDGE]?: CapabilityBridge };
  if (typeof prototype?.getTerminalCapabilityOverrides !== "function") return () => {};
  let bridge = prototype[BRIDGE];
  if (!bridge) {
    const original = prototype.getTerminalCapabilityOverrides;
    const owners = new Set<symbol>();
    const getter: CapabilityGetter = function (this: SettingsManager, ...args: Parameters<CapabilityGetter>) {
      const overrides = original.apply(this, args);
      return owners.size ? terminalDefaults(overrides) : overrides;
    };
    bridge = { original, getter, owners };
    prototype[BRIDGE] = bridge;
    prototype.getTerminalCapabilityOverrides = getter;
  }
  const owner = Symbol();
  bridge.owners.add(owner);
  return () => {
    if (!bridge.owners.delete(owner) || bridge.owners.size) return;
    // A later third-party wrapper may retain ours; leave it installed and ours inactive.
    if (prototype.getTerminalCapabilityOverrides === bridge.getter) prototype.getTerminalCapabilityOverrides = bridge.original;
    if (prototype[BRIDGE] === bridge) delete prototype[BRIDGE];
  };
}
