import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { RoomView } from '@/components/RoomView';

// RoomView is drawn from a fixed state, as in raise-hand.test.tsx.
const toggleScreenShare = vi.fn();

vi.mock('@/hooks/useRoom', () => ({
  useRoom: () => ({
    state: {
      phase: 'in-call',
      role: 'guest',
      companion: false,
      localStream: null,
      localName: 'Ana',
      connectionWarning: null,
      syncReportUrl: null,
      chaptersUrl: null,
      backupBlobUrl: null,
      wavBackupBlobUrl: null,
      peerRecording: false,
      remoteStream: null,
      remotePeers: [],
      remoteScreenStream: null,
      localScreenStream: null,
      screenSharing: false,
      capabilities: {},
      finalizingGuests: [],
      messages: [],
      markers: [],
      takes: [],
      summary: null,
      recordingError: null,
      drained: true,
      sidecarsSaved: false,
    },
    join: vi.fn(),
    leave: vi.fn(),
    setMic: vi.fn(),
    setCam: vi.fn(),
    toggleScreenShare,
  }),
}));

describe('RoomView: slides that cannot be presented', () => {
  it('shows the reason the presenter hook resolves with', async () => {
    toggleScreenShare.mockResolvedValue('This PDF is over 100 MB.');
    render(<RoomView slug="abc-defg-hij" />);
    fireEvent.click(screen.getByRole('button', { name: 'Present a photo, video or your rear camera' }));
    const menu = screen.getByRole('menu', { name: 'Present options' });
    const input = within(menu).getByText('Slides (PDF or pictures)').closest('label')!.querySelector('input')!;
    const files = [new File(['%PDF'], 'big.pdf', { type: 'application/pdf' })];

    fireEvent.change(input, { target: { files } });

    expect(await screen.findByRole('alert')).toHaveTextContent('This PDF is over 100 MB.');
    expect(toggleScreenShare).toHaveBeenCalledWith(files);
  });
});
