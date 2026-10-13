import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { CameraSettings } from '@/components/CameraSettings';

const caps = {
  exposureMode: ['continuous', 'manual'],
  exposureTime: { min: 10, max: 1000, step: 10 },
  whiteBalanceMode: ['continuous', 'manual'],
  colorTemperature: { min: 2000, max: 8000, step: 100 },
  zoom: { min: 1, max: 5, step: 1 },
};

function fakeTrack(capabilities: Record<string, unknown>, settings: Record<string, unknown>) {
  const track = {
    settings,
    getCapabilities: () => capabilities,
    getSettings: () => track.settings,
    getConstraints: () => ({}),
    applyConstraints: vi.fn().mockResolvedValue(undefined),
  };
  return track as typeof track & MediaStreamTrack;
}

const slider = (name: string) => screen.getByRole('slider', { name }) as HTMLInputElement;
const calls = (track: { applyConstraints: ReturnType<typeof vi.fn> }) =>
  track.applyConstraints.mock.calls.map((c) => c[0].advanced);

describe('CameraSettings', () => {
  it('draws a labelled region with a row for each control the camera offers', () => {
    const track = fakeTrack(caps, { exposureMode: 'manual', zoom: 2 });
    render(<CameraSettings track={track} onClose={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Camera settings' });
    expect(within(region).getByRole('heading', { name: 'Camera settings' })).toBeInTheDocument();
    expect(within(region).getByText('Changes your picture in the call and in your recording.')).toBeInTheDocument();
    expect(within(region).getAllByRole('slider').map((s) => s.getAttribute('min') + '..' + s.getAttribute('max'))).toEqual([
      '10..1000',
      '2000..8000',
      '1..5',
    ]);
    expect(slider('Zoom').value).toBe('2');
    expect(slider('Zoom').getAttribute('step')).toBe('1');
    expect(
      within(region)
        .getAllByRole('checkbox')
        .map((c) => (c as HTMLInputElement).labels?.[0]?.textContent)
    ).toEqual(['Auto exposure', 'Auto white balance']);
    expect((screen.getByRole('checkbox', { name: 'Auto exposure' }) as HTMLInputElement).checked).toBe(false);
    expect(region.className).toMatch(/max-h-\[40dvh\].*overflow-y-auto.*overflow-x-hidden/);
    expect(within(region).getByText('Zoom').className).toMatch(/\bw-36\b.*\btruncate\b/);
    for (const input of region.querySelectorAll('input')) expect(input.className).toMatch(/\bh-11\b/);
    for (const name of ['Reset', 'Close']) expect(screen.getByRole('button', { name }).className).toMatch(/\bmin-h-11\b/);
  });

  it('sends a moved slider to the camera, by its key', async () => {
    const track = fakeTrack(caps, {});
    render(<CameraSettings track={track} onClose={vi.fn()} />);
    fireEvent.change(slider('Zoom'), { target: { value: '3' } });
    expect(slider('Zoom').value).toBe('3');
    await waitFor(() => expect(calls(track)).toEqual([[{ zoom: 3 }]]));
  });

  it('sends a switch as continuous or manual', async () => {
    const track = fakeTrack(caps, { exposureMode: 'continuous' });
    render(<CameraSettings track={track} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto exposure' }));
    await waitFor(() => expect(calls(track)).toEqual([[{ exposureMode: 'manual' }]]));
  });

  it('keeps one request in flight and sends only the newest value that arrived meanwhile', async () => {
    const track = fakeTrack(caps, {});
    let finish!: () => void;
    track.applyConstraints.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<CameraSettings track={track} onClose={vi.fn()} />);

    fireEvent.change(slider('Zoom'), { target: { value: '2' } });
    fireEvent.change(slider('Zoom'), { target: { value: '3' } });
    fireEvent.change(slider('Zoom'), { target: { value: '4' } });
    expect(slider('Zoom').value).toBe('4');
    expect(calls(track)).toEqual([[{ zoom: 2 }]]);

    await act(async () => finish());
    await waitFor(() => expect(calls(track)).toEqual([[{ zoom: 2 }], [{ zoom: 4 }]]));
  });

  it('says so, shows what the camera has, and clears the line on the next success', async () => {
    const track = fakeTrack(caps, { zoom: 1 });
    track.applyConstraints.mockRejectedValueOnce(new Error('refused'));
    render(<CameraSettings track={track} onClose={vi.fn()} />);

    track.settings = { zoom: 2 };
    fireEvent.change(slider('Zoom'), { target: { value: '5' } });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your camera did not take that setting.');
    expect(screen.getByRole('region', { name: 'Camera settings' }).contains(alert)).toBe(true);
    expect(slider('Zoom').value).toBe('2');

    fireEvent.change(slider('Zoom'), { target: { value: '3' } });
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('drops what was waiting behind a refused request, and shows what the camera has', async () => {
    const track = fakeTrack(caps, { zoom: 1, exposureTime: 100 });
    let refuse!: () => void;
    track.applyConstraints.mockImplementationOnce(() => new Promise<void>((_, reject) => (refuse = () => reject(new Error('no')))));
    render(<CameraSettings track={track} onClose={vi.fn()} />);

    fireEvent.change(slider('Zoom'), { target: { value: '4' } });
    fireEvent.change(slider('Exposure time'), { target: { value: '500' } });
    await act(async () => refuse());

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(slider('Exposure time').value).toBe('100');
    expect(calls(track)).toEqual([[{ zoom: 4 }]]);
  });

  it('survives a camera that throws at once', async () => {
    const track = fakeTrack(caps, {});
    track.applyConstraints.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    render(<CameraSettings track={track} onClose={vi.fn()} />);
    fireEvent.change(slider('Zoom'), { target: { value: '3' } });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('disables Exposure time and Colour temperature while their automatic switch is on', async () => {
    const track = fakeTrack(caps, { exposureMode: 'continuous', whiteBalanceMode: 'continuous' });
    render(<CameraSettings track={track} onClose={vi.fn()} />);
    expect(slider('Exposure time')).toBeDisabled();
    expect(slider('Colour temperature')).toBeDisabled();
    expect(slider('Zoom')).not.toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto exposure' }));
    expect(slider('Exposure time')).not.toBeDisabled();
    expect(slider('Colour temperature')).toBeDisabled();
    await waitFor(() => expect(calls(track)).toHaveLength(1));
  });

  it('never disables a slider whose switch the camera does not offer', () => {
    const track = fakeTrack({ exposureTime: caps.exposureTime, colorTemperature: caps.colorTemperature }, {});
    render(<CameraSettings track={track} onClose={vi.fn()} />);
    expect(slider('Exposure time')).not.toBeDisabled();
    expect(slider('Colour temperature')).not.toBeDisabled();
  });

  it('puts every control back to what it was when the panel opened, switches first', async () => {
    const track = fakeTrack(caps, { exposureMode: 'manual', exposureTime: 200, zoom: 2 });
    render(<CameraSettings track={track} onClose={vi.fn()} />);

    fireEvent.change(slider('Zoom'), { target: { value: '4' } });
    fireEvent.change(slider('Exposure time'), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Auto exposure' }));
    await waitFor(() => expect(calls(track)).toHaveLength(3));
    track.applyConstraints.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(slider('Zoom').value).toBe('2');
    expect(slider('Exposure time').value).toBe('200');
    expect((screen.getByRole('checkbox', { name: 'Auto exposure' }) as HTMLInputElement).checked).toBe(false);
    await waitFor(() => expect(calls(track)).toHaveLength(5));
    expect(calls(track)).toEqual([
      [{ exposureMode: 'manual' }],
      [{ whiteBalanceMode: 'manual' }],
      [{ exposureTime: 200 }],
      [{ colorTemperature: 2000 }],
      [{ zoom: 2 }],
    ]);
  });

  it('calls onClose from Close', () => {
    const onClose = vi.fn();
    render(<CameraSettings track={fakeTrack(caps, {})} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
