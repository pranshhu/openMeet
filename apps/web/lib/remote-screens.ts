export interface RemoteScreen {
  peerId: string;
  stream: MediaStream;
}

/** That person's screen: last in the list for someone with none yet, in place for someone with one. The same list when they already hold this stream. */
export function withScreen(list: RemoteScreen[], peerId: string, stream: MediaStream): RemoteScreen[] {
  const held = list.find((r) => r.peerId === peerId);
  if (held?.stream === stream) return list;
  return held ? list.map((r) => (r === held ? { peerId, stream } : r)) : [...list, { peerId, stream }];
}

/** The list without that person's screen; with `stream` given, only when it is the one they hold. The same list when nothing goes. */
export function withoutScreen(list: RemoteScreen[], peerId: string, stream?: MediaStream): RemoteScreen[] {
  const rest = list.filter((r) => r.peerId !== peerId || (stream !== undefined && r.stream !== stream));
  return rest.length === list.length ? list : rest;
}

/** The label of a screen presented by that person. */
export function screenLabelOf(p: { name?: string | null; companion?: boolean | undefined }): string {
  return p.companion ? `${p.name || 'Guest'} (Presenting)` : `${p.name ?? 'Guest'}'s screen`;
}
