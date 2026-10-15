'use client';

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { MAX_PASSCODE_LENGTH } from '@openmeet/protocol';

/**
 * The one field of the screen a room with a passcode shows a person before
 * they are in. What was typed is sent and the field is emptied, so a wrong
 * passcode is never left to be edited into a guess and the next try starts
 * clean, with the focus back in the field.
 */
export function PasscodeForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (code: string) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  useEffect(() => input.current?.focus(), []);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (code === '') return;
    onSubmit(code);
    setCode('');
    input.current?.focus();
  }

  const focus = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ab4f8]';
  return (
    <form onSubmit={submit} className="flex w-full flex-col gap-2 text-left">
      <label htmlFor={id} className="text-sm text-white/80">
        Passcode
      </label>
      <div className="flex gap-2">
        <input
          ref={input}
          id={id}
          type="password"
          autoComplete="off"
          maxLength={MAX_PASSCODE_LENGTH}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className={`h-11 min-w-0 flex-1 rounded-full bg-white/10 px-4 text-[15px] text-white ring-1 ring-inset ring-white/30 ${focus}`}
        />
        <button
          type="submit"
          disabled={code === ''}
          className={`inline-flex h-11 shrink-0 items-center rounded-full bg-[#8ab4f8] px-5 text-sm font-medium text-[#202124] transition-colors hover:bg-[#a8c7fa] disabled:opacity-40 ${focus}`}
        >
          Join
        </button>
      </div>
      {wrong && (
        <p role="alert" className="text-sm text-[#f28b82]">
          That passcode isn’t right. Try again.
        </p>
      )}
    </form>
  );
}
