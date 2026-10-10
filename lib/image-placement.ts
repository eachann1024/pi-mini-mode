/** Use the same cursor-commit workaround as Otty's hover/draft previews:
 * end DEC 2026 before Kitty APCs so placement cannot use a buffered cursor.
 * Resume Pi's frame afterwards, preserving the sequence and metadata ID. */
function directOtty(): boolean {
  return process.env.TERM_PROGRAM?.toLowerCase() === "otty"
    && !process.env.TMUX && !process.env.STY && !/^(tmux|screen)/i.test(process.env.TERM ?? "");
}

export function commitImageCursor(line: string): string {
  if (!directOtty()) return line;
  const start = line.indexOf("\x1b_G");
  if (start < 0) return line;
  const last = line.lastIndexOf("\x1b_G");
  const end = line.indexOf("\x1b\\", last);
  if (end < 0) return line;
  // The protocol chunks must stay contiguous for Pi's placement cache parser.
  return line.slice(0, start) + "\x1b[?2026l\x1b[0m" + line.slice(start, end + 2)
    + "\x1b[?2026h\x1b[0m" + line.slice(end + 2);
}

/** Pi's fullscreen cache replaces uploads with placement-only commands on scroll.
 * Otty can lose these placements after clearing the previous frame. Retain Pi's
 * cache bookkeeping/eviction, but send the original (possibly cropped) upload.
 * This private adapter is restricted to direct Otty and restored on unmount. */
export function attachImageRedraw(tui: unknown): (() => void) | undefined {
  if (!directOtty()) return;
  type Prepared = { lines: string[]; evictedImageDeletion: string };
  const host = tui as { mode?: string; prepareKittyScreen?(screen: string[]): Prepared };
  if (host.mode !== "fullscreen" || typeof host.prepareKittyScreen !== "function") return;
  const original = host.prepareKittyScreen;
  const descriptor = Object.getOwnPropertyDescriptor(host, "prepareKittyScreen");
  const prepare = (screen: string[]): Prepared => {
    const result = original.call(host, screen);
    return directOtty() ? { ...result, lines: screen } : result;
  };
  host.prepareKittyScreen = prepare;
  return () => {
    if (host.prepareKittyScreen !== prepare) return;
    if (descriptor) Object.defineProperty(host, "prepareKittyScreen", descriptor);
    else delete host.prepareKittyScreen;
  };
}
