import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WaitingRoom } from '@/components/WaitingRoom';

describe('WaitingRoom', () => {
  it('renders host copy for host', () => {
    render(<WaitingRoom role="host" localStream={null} localName="Host" onLeave={vi.fn()} />);
    expect(screen.getByText('Waiting for others to join')).toBeInTheDocument();
    expect(
      screen.getByText(/Share the invite link\. You’ll connect automatically as people arrive\./i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/your guest/i)).not.toBeInTheDocument();
  });

  it('renders guest copy for guest', () => {
    render(<WaitingRoom role="guest" localStream={null} localName="Guest" onLeave={vi.fn()} />);
    expect(screen.getByText('Waiting for the host to join')).toBeInTheDocument();
    expect(screen.getByText(/Hang tight — the call starts as soon as the host arrives\./i)).toBeInTheDocument();
  });

  it('copyLink copies origin and pathname without query string', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    window.history.pushState({}, '', '/r/xyz-abcd-pqr/?producer=1');

    render(<WaitingRoom role="host" localStream={null} localName="Host" onLeave={vi.fn()} />);
    const copyBtn = screen.getByRole('button', { name: /copy invite link/i });
    fireEvent.click(copyBtn);

    expect(writeText).toHaveBeenCalledWith(`${location.origin}/r/xyz-abcd-pqr/`);
  });

  it('a camera turned off in the lobby shows the initial, and the mic can be muted while waiting', () => {
    const audio = { kind: 'audio', enabled: true };
    const video = { kind: 'video', enabled: false };
    const stream = {
      getTracks: () => [audio, video],
      getAudioTracks: () => [audio],
      getVideoTracks: () => [video],
    } as unknown as MediaStream;
    const onToggleMic = vi.fn();

    const { container } = render(
      <WaitingRoom
        role="host"
        localStream={stream}
        localName="Host"
        onLeave={vi.fn()}
        onToggleMic={onToggleMic}
        onToggleCam={vi.fn()}
      />
    );
    expect(screen.getByText('H')).toBeInTheDocument();
    expect(container.querySelector('video')).toHaveClass('opacity-0');
    expect(screen.getByRole('button', { name: 'Turn on camera' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Turn off microphone' }));
    expect(onToggleMic).toHaveBeenCalledWith(false);
    expect(screen.getByRole('button', { name: 'Turn on microphone' })).toBeInTheDocument();
  });

  it('shows no device toggles for a stream without tracks (present-only)', () => {
    const empty = { getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
    render(
      <WaitingRoom
        role="guest"
        localStream={empty}
        localName="Screen"
        onLeave={vi.fn()}
        onToggleMic={vi.fn()}
        onToggleCam={vi.fn()}
      />
    );
    expect(screen.getByText('S')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /microphone|camera/ })).not.toBeInTheDocument();
  });

  // Mirrored like the lobby preview (display only); a rear camera shows the world.
  it.each([
    ['user', true],
    ['environment', false],
  ])('mirrors the self-view only for a front camera (%s)', (facingMode, mirrored) => {
    const video = { kind: 'video', enabled: true, getSettings: () => ({ facingMode }) };
    const stream = {
      getTracks: () => [video],
      getAudioTracks: () => [],
      getVideoTracks: () => [video],
    } as unknown as MediaStream;
    const { container } = render(<WaitingRoom role="host" localStream={stream} localName="Host" onLeave={vi.fn()} />);
    expect(container.querySelector('video')!.classList.contains('-scale-x-100')).toBe(mirrored);
  });
});
