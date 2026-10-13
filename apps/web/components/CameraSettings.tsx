'use client';

import { useRef, useState } from 'react';
import { applyCameraSetting, cameraControls, type CameraControl } from '@/lib/camera-controls';

// The slider that only means something while its automatic switch is off.
const AUTO_OF: Record<string, string> = { exposureTime: 'exposureMode', colorTemperature: 'whiteBalanceMode' };

/**
 * Sliders for the settings this camera offers the browser. A change goes to the
 * camera behind the call's video track, so it shows in the call and in a
 * recording that is running. Nothing is stored or sent to anyone.
 */
export function CameraSettings({ track, onClose }: { track: MediaStreamTrack; onClose: () => void }) {
  const [opened] = useState(() => cameraControls(track));
  const [controls, setControls] = useState(opened);
  const [refused, setRefused] = useState(false);
  // Settings waiting for the request in flight, by key, oldest first. A slider
  // that is dragged leaves only its newest value here.
  const waiting = useRef(new Map<string, number | boolean>());
  const sending = useRef(false);

  async function send() {
    if (sending.current) return;
    sending.current = true;
    while (waiting.current.size > 0) {
      const [key, value] = waiting.current.entries().next().value!;
      waiting.current.delete(key);
      try {
        await applyCameraSetting(track, key, value);
        setRefused(false);
      } catch {
        waiting.current.clear();
        setRefused(true);
        setControls(cameraControls(track));
      }
    }
    sending.current = false;
  }

  function change(key: string, patch: { on: boolean } | { value: number }) {
    setControls((all) => all.map((c) => (c.key === key ? ({ ...c, ...patch } as CameraControl) : c)));
    ask(key, 'on' in patch ? patch.on : patch.value);
  }

  function ask(key: string, value: number | boolean) {
    waiting.current.set(key, value);
    void send();
  }

  function reset() {
    setControls(opened);
    for (const c of opened) if (c.kind === 'switch') ask(c.key, c.on);
    for (const c of opened) if (c.kind === 'range') ask(c.key, c.value);
  }

  const on = (key: string) => controls.some((c) => c.key === key && c.kind === 'switch' && c.on);

  return (
    <section
      aria-label="Camera settings"
      className="mb-2 max-h-[40dvh] w-full max-w-md overflow-y-auto overflow-x-hidden rounded-2xl bg-[#2a2b2e] px-4 py-3 text-white ring-1 ring-white/5"
    >
      <h2 className="text-sm font-medium">Camera settings</h2>
      <p className="text-xs text-white/70">Changes your picture in the call and in your recording.</p>
      <div className="mt-1">
        {controls.map((c) => (
          <label key={c.key} className="flex items-center gap-3">
            <span className="w-36 shrink-0 truncate text-sm">{c.label}</span>
            {c.kind === 'range' ? (
              <input
                type="range"
                min={c.min}
                max={c.max}
                step={c.step}
                value={c.value}
                disabled={on(AUTO_OF[c.key] ?? '')}
                onChange={(e) => change(c.key, { value: Number(e.target.value) })}
                className="h-11 min-w-0 flex-1 accent-[#8ab4f8] disabled:opacity-40"
              />
            ) : (
              <input
                type="checkbox"
                checked={c.on}
                onChange={(e) => change(c.key, { on: e.target.checked })}
                className="h-11 w-5 accent-[#8ab4f8]"
              />
            )}
          </label>
        ))}
      </div>
      {refused && (
        <p role="alert" className="mt-2 text-xs text-[#f28b82]">
          Your camera did not take that setting.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="min-h-11 rounded-full px-4 text-sm text-[#8ab4f8] hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-full px-4 text-sm text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]"
        >
          Close
        </button>
      </div>
    </section>
  );
}
