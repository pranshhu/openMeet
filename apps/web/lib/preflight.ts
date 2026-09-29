import { MAX_RECORDED_PEERS } from '@openmeet/protocol';
import { bytesPerHour, recordingFolderBytesPerHour, type QualityPreset } from './quality';

/**
 * Pre-join checks.
 *
 * Guest-side setup problems are the most common way a remote recording is
 * ruined, and they are all cheapest to catch before anyone presses Record.
 * Every check here answers "will this session produce a usable file?", not
 * "does this device exist".
 */

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  level: CheckLevel;
  message: string;
}

/**
 * Browser storage left vs. what an hour of this device's own backup costs.
 *
 * The figure is the browser's storage quota (navigator.storage.estimate), not
 * free space on the disk the recordings are saved to, so it is named as such.
 * Only this device's backup lives there — its camera MP4 plus a WAV master,
 * budgeted as stereo — whoever joins; the host's copies of everyone's tracks go
 * to the recording folder instead (folderCheck).
 */
export function diskCheck(
  quota: number | undefined,
  usage: number | undefined,
  preset: QualityPreset
): Check {
  if (quota === undefined) {
    return {
      id: 'disk',
      level: 'warn',
      message: 'Could not read how much browser storage (for backups) is available\u00a0— check your disk has room before a long session.',
    };
  }
  const free = Math.max(0, quota - (usage ?? 0));
  const perHour = bytesPerHour(preset, 2);
  const hours = free / perHour;
  const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB of browser storage available (for backups)`;
  if (hours < 1) {
    return {
      id: 'disk',
      level: 'fail',
      message: `Only ${gb(free)}\u00a0— under an hour at this quality. Free up space or lower the quality.`,
    };
  }
  if (hours < 3) {
    return {
      id: 'disk',
      level: 'warn',
      message: `${gb(free)}\u00a0— about ${hours.toFixed(1)} hours at this quality.`,
    };
  }
  return {
    id: 'disk',
    level: 'ok',
    message: `${gb(free)}\u00a0— roughly ${Math.floor(hours)} hours at this quality.`,
  };
}

/**
 * What the host's recording folder takes per hour: every recorded
 * participant's camera MP4 and stereo WAV. The lobby cannot know how many will
 * join, so it budgets for the room's cap. The browser cannot see free space on
 * that drive, so this informs rather than judges.
 */
export function folderCheck(preset: QualityPreset, peers = MAX_RECORDED_PEERS): Check {
  const gb = (recordingFolderBytesPerHour(preset, peers) / 1e9).toFixed(1);
  return {
    id: 'folder',
    level: 'ok',
    message: `Recording folder: about ${gb} GB per hour for ${peers} people (more with screen sharing).`,
  };
}

/** Is the mic actually producing signal, or muted at the OS level? */
export function micCheck(peakLevel: number, elapsedMs: number): Check {
  if (elapsedMs < 1500) return { id: 'mic', level: 'warn', message: 'Listening…' };
  if (peakLevel < 0.005) {
    return { id: 'mic', level: 'fail', message: 'No sound detected. Check the mic is not muted in your OS or hardware.' };
  }
  if (peakLevel > 0.98) {
    return { id: 'mic', level: 'warn', message: 'Mic is clipping — lower the input gain, or you will bake distortion into the recording.' };
  }
  return { id: 'mic', level: 'ok', message: 'Mic is picking up sound.' };
}

export function codecCheck(mime: string | null): Check {
  return mime
    ? { id: 'codec', level: 'ok', message: 'This browser can record MP4.' }
    : { id: 'codec', level: 'fail', message: 'This browser cannot record MP4. Use Google Chrome.' };
}

/**
 * The WAV master is a bonus, not a requirement — MP4 recording works without
 * it — so a missing PCM capture path is a warning, never a fail.
 */
export function wavCheck(supported: boolean): Check {
  return supported
    ? { id: 'wav', level: 'ok', message: 'This browser can capture an uncompressed WAV master.' }
    : { id: 'wav', level: 'warn', message: 'No uncompressed WAV master in this browser.' };
}

/**
 * What the network can offer, from the candidate types gathering produced.
 *
 * A `relay` candidate means a call can still connect when both sides sit behind
 * symmetric NAT. Without one it connects on most networks, and nothing a guest
 * can change here would help, so a direct path is not flagged — only the case
 * where not even STUN answered.
 */
export function connectionCheck(types: Set<string>): Check {
  if (types.has('relay')) {
    return { id: 'connection', level: 'ok', message: 'Relay available — this call can connect from any network.' };
  }
  if (types.has('srflx')) {
    return {
      id: 'connection',
      level: 'ok',
      message: 'Direct connection available — works on most networks.',
    };
  }
  return {
    id: 'connection',
    level: 'warn',
    message: 'Couldn’t reach the connection server — a firewall may block the call. Try another network if it won’t connect.',
  };
}

/** Gather ICE candidates solo to learn which paths this network allows. */
export async function probeIce(
  iceServers: RTCIceServer[],
  timeoutMs = 4000,
  factory?: (c: RTCConfiguration) => RTCPeerConnection
): Promise<Set<string>> {
  const types = new Set<string>();
  const make = factory ?? ((c: RTCConfiguration) => new RTCPeerConnection(c));
  const pc = make({ iceServers });
  try {
    // A data channel is enough to make gathering happen without media.
    pc.createDataChannel('probe');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, timeoutMs);
      pc.onicecandidate = (ev) => {
        if (!ev.candidate) {
          clearTimeout(done);
          resolve();
          return;
        }
        const t = ev.candidate.type ?? guessType(ev.candidate.candidate);
        if (t) types.add(t);
        // A relay answers the only question that matters; stop early.
        if (t === 'relay') {
          clearTimeout(done);
          resolve();
        }
      };
    });
  } catch {
    /* probing is best-effort; an empty set reads as "unknown" downstream */
  } finally {
    pc.close();
  }
  return types;
}

/** Fallback for browsers that don't expose `candidate.type`. */
function guessType(candidate: string): string | null {
  const m = /\btyp (\w+)/.exec(candidate);
  return m?.[1] ?? null;
}

/** Worst level across checks — what the join button should react to. */
export function overallLevel(checks: Check[]): CheckLevel {
  if (checks.some((c) => c.level === 'fail')) return 'fail';
  if (checks.some((c) => c.level === 'warn')) return 'warn';
  return 'ok';
}
