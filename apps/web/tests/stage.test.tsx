import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Stage, type StageFeed } from '@/components/Stage';

const local: StageFeed = { stream: null, name: 'Alice', muted: true, camOff: true };
const remote: StageFeed = { stream: null, name: 'Bob', muted: false, camOff: true };
const fakeStream = { id: 'scr' } as unknown as MediaStream;

describe('Stage', () => {
  it('solo: shows only the local feed, no swap PiP', () => {
    render(
      <Stage
        local={local}
        remote={null}
        remoteScreen={null}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.queryByText('Bob')).toBeNull();
    expect(screen.queryByLabelText('Swap spotlight')).toBeNull();
  });

  it('focused: both feeds + a tap-to-swap PiP that fires onSwapSpotlight', () => {
    const onSwap = vi.fn();
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={onSwap}
      />
    );
    expect(screen.getByText('Alice')).toBeTruthy();
    expect(screen.getByText('Bob')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Swap spotlight'));
    expect(onSwap).toHaveBeenCalledOnce();
  });

  it('focused: the spotlight tag is capped so it wraps left of the PiP; the PiP tag is not', () => {
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    // spotlight === 'remote' -> big tile is Bob, PiP tile is Alice.
    expect(screen.getByText('Bob').className).toContain('max-w-[calc(100%-9rem)]');
    expect(screen.getByText('Alice').className).not.toContain('max-w-[calc(100%-9rem)]');
  });

  // A long name used to wrap to 3-4 lines and grow out of the top of the PiP.
  it('name tags stay on one line and truncate, with the full name on hover', () => {
    const long = 'Guestopher Q. Extremely-Long-Surname (You)';
    const { unmount } = render(
      <Stage
        local={{ ...local, name: long }}
        remote={remote}
        remoteScreen={null}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    for (const name of [long, 'Bob']) {
      const tag = screen.getByText(name);
      expect(tag.className).toMatch(/\btruncate\b/);
      expect(tag.className).toMatch(/\bmax-w-/);
      expect(tag).toHaveAttribute('title', name);
    }
    unmount();

    // Grid (3+ people) tiles too.
    render(
      <Stage
        local={{ ...local, name: long }}
        remote={remote}
        others={[{ ...remote, name: 'Carol' }]}
        remoteScreen={null}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.getByText('Carol').className).toMatch(/\btruncate\b/);
    expect(screen.getByText(long).className).toMatch(/\bmax-w-/);
  });

  it('presenting (remote screen): shows the shared screen surface + cameras', () => {
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={fakeStream}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.getByText("Bob's screen")).toBeTruthy();
    expect(screen.getByText('Alice')).toBeTruthy(); // camera column
  });

  it('presenting (two people present): remote screen is labelled with presenter name', () => {
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={fakeStream}
        localPresenting={true}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.getByText("Bob's screen")).toBeTruthy();
  });

  it('presenting (local sharer with self-preview): shows their own screen', () => {
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localScreen={fakeStream}
        localPresenting={true}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.getByText(/your screen/i)).toBeTruthy();
    expect(screen.queryByText('Shared screen')).toBeNull();
  });

  it('presenting (local sharer, no preview yet): falls back to the placeholder', () => {
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localScreen={null}
        localPresenting={true}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.getByText(/you’re presenting/i)).toBeTruthy();
    expect(screen.getByText('Everyone in the call can see what you’re sharing.')).toBeTruthy();
    expect(screen.queryByText(/the other participant/i)).toBeNull();
  });

  // The placeholder was a dead end: the only way out was a control-bar button
  // that looked the same whether you were presenting or not.
  it('presenting placeholder offers Stop presenting when the caller can stop it', () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localScreen={null}
        localPresenting={true}
        spotlight="remote"
        onSwapSpotlight={() => {}}
        onStopPresenting={onStop}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop presenting' }));
    expect(onStop).toHaveBeenCalledTimes(1);

    rerender(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={null}
        localScreen={null}
        localPresenting={true}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    expect(screen.queryByRole('button', { name: 'Stop presenting' })).toBeNull();
  });

  it('presenting camera column lists other people first and you last', () => {
    const { container } = render(
      <Stage
        local={local}
        remote={remote}
        others={[{ stream: null, name: 'Cara', muted: false, camOff: true }]}
        remoteScreen={fakeStream}
        localPresenting={false}
        screenLabel="Bob's screen"
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    const column = container.querySelector('.md\\:flex')!;
    const names = Array.from(column.querySelectorAll('span[title]')).map((el) => el.textContent);
    expect(names).toEqual(['Bob', 'Cara', 'Alice']);
  });

  // Your tile is last, so an index key changed whenever someone joined or left
  // mid-presentation, and your camera remounted (a black flash).
  it('presenting camera column keeps your tile mounted when someone joins', () => {
    const props = {
      local,
      remote,
      remoteScreen: fakeStream,
      localPresenting: false,
      spotlight: 'remote' as const,
      onSwapSpotlight: () => {},
    };
    const { container, rerender } = render(<Stage {...props} />);
    const column = container.querySelector('.md\\:flex')!;
    const mine = column.lastElementChild;
    rerender(<Stage {...props} others={[{ stream: null, name: 'Cara', muted: false, camOff: true }]} />);
    expect(column.lastElementChild).toBe(mine);
  });

  it('presenting (remote screen): VideoTile for remote screen is not muted so shared audio is heard', () => {
    const { container } = render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={fakeStream}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    const videoEls = container.querySelectorAll('video');
    const screenVideo = Array.from(videoEls).find((v) => (v as any).srcObject === fakeStream);
    expect(screenVideo).toBeDefined();
    expect(screenVideo?.muted).toBe(false);
  });

  it('presenting (companion presenter): screen is labelled Name (Presenting)', () => {
    render(
      <Stage
        local={local}
        remote={remote}
        remoteScreen={fakeStream}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
        screenLabel="Charlie (Presenting)"
      />
    );
    expect(screen.getByText('Charlie (Presenting)')).toBeTruthy();
    expect(screen.queryByText("Charlie (Presenting)'s screen")).toBeNull();
  });

  it('presenting (companion client): remote screen VideoTile is muted', () => {
    const { container } = render(
      <Stage
        companion={true}
        local={local}
        remote={remote}
        remoteScreen={fakeStream}
        localPresenting={false}
        spotlight="remote"
        onSwapSpotlight={() => {}}
      />
    );
    const videoEls = container.querySelectorAll('video');
    const screenVideo = Array.from(videoEls).find((v) => (v as any).srcObject === fakeStream);
    expect(screenVideo).toBeDefined();
    expect(screenVideo?.muted).toBe(true);
  });
});

