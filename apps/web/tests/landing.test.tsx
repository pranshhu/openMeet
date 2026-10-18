import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import Landing from '@/app/page';

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

describe('Landing page', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as any;
    vi.stubGlobal('fetch', vi.fn());
    delete (window as any).location;
    (window as any).location = new URL('http://localhost:3000/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('checkoutUrl: null → today’s plain landing (no wall)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          checkoutUrl: null,
          sponsors: [],
          available: 1,
        }),
        { status: 200 }
      )
    );

    render(<Landing />);

    // Should render hero content
    expect(await screen.findByRole('heading', { name: /Studio-quality remote recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Room/i })).toBeInTheDocument();

    // No sponsor wall
    expect(screen.queryByLabelText('Sponsors')).toBeNull();
    expect(screen.queryByRole('link', { name: /Sponsor openMeet/i })).toBeNull();
  });

  it('fetch failure → plain landing', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'));

    render(<Landing />);

    expect(await screen.findByRole('heading', { name: /Studio-quality remote recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Room/i })).toBeInTheDocument();
    expect(screen.queryByLabelText('Sponsors')).toBeNull();
  });

  it('page renders the pitch and the panel side by side when configured', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          checkoutUrl: 'https://buy.polar.sh/openmeet',
          sponsors: [
            { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.5 },
          ],
          available: 0.5,
        }),
        { status: 200 }
      )
    );

    const { container } = render(<Landing />);
    expect(await screen.findByLabelText('Sponsors')).toBeInTheDocument();

    // Pitch elements on the left
    const header = container.querySelector('header.head');
    expect(header).toBeInTheDocument();
    expect(header!.textContent).toContain('openMeet');

    expect(screen.getByRole('heading', { name: /Studio-quality remote recording/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New Room/i })).toBeInTheDocument();

    // Side panel on the right
    const side = container.querySelector('aside.side');
    expect(side).toBeInTheDocument();
    expect(side!.querySelector('[aria-label="Sponsors"]')).toBeInTheDocument();

    // Footer with github link and checkout sponsor link
    const footerLink = screen.getByRole('link', { name: /open-source/i });
    expect(footerLink).toBeInTheDocument();
    expect(container.textContent).toContain('self-hostable · MIT licensed');

    const sponsorLinks = screen.getAllByRole('link', { name: /Sponsor openMeet/i });
    expect(sponsorLinks.some((l) => l.getAttribute('href') === 'https://buy.polar.sh/openmeet')).toBe(true);
  });

  it('?sponsored=1 → thank-you line', async () => {
    (window as any).location = new URL('http://localhost:3000/?sponsored=1');

    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          checkoutUrl: 'https://buy.polar.sh/openmeet',
          sponsors: [
            { name: 'Acme', url: 'https://acme.com', logo: null, weight: 0.5 },
          ],
          available: 0.5,
        }),
        { status: 200 }
      )
    );

    render(<Landing />);

    expect(
      await screen.findByText("Thank you! Your logo appears here once it's approved.")
    ).toBeInTheDocument();
  });
});


describe.each([
  ['plain layout', null],
  ['sponsor layout', 'https://buy.polar.sh/openmeet'],
])('Choose your own link, %s', (_layout, checkoutUrl) => {
  const roomCalls = () =>
    (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).includes('/api/rooms')) as [
      string,
      RequestInit,
    ][];

  async function showPage(roomReply: () => Response | Promise<Response> = () => new Response('{}', { status: 500 })) {
    (fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) =>
      String(url).includes('/api/sponsors')
        ? new Response(JSON.stringify({ checkoutUrl, sponsors: [], available: 1 }), { status: 200 })
        : roomReply()
    );
    render(<Landing />);
    if (checkoutUrl) await screen.findByLabelText('Sponsors');
    else await screen.findByRole('heading', { name: /Studio-quality remote recording/i });
  }

  async function openForm(roomReply?: () => Response | Promise<Response>) {
    await showPage(roomReply);
    fireEvent.click(screen.getByText('Choose your own link'));
  }

  function submit(typed: string) {
    fireEvent.change(screen.getByLabelText('Link name'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
  }

  beforeEach(() => {
    globalThis.ResizeObserver = MockResizeObserver as any;
    vi.stubGlobal('fetch', vi.fn());
    delete (window as any).location;
    (window as any).location = { href: '/', search: '' };
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('describes the field and the terms of the link', async () => {
    await openForm();
    const input = screen.getByLabelText('Link name') as HTMLInputElement;
    expect(screen.getByText('Choose your own link').tagName).toBe('SUMMARY');
    expect(screen.getByText('Choose your own link').closest('details')).toContainElement(input);
    expect(screen.getByText('/r/')).toBeInTheDocument();
    expect(input.placeholder).toBe('my-show');
    expect(input.maxLength).toBe(32);
    expect(input.getAttribute('autocapitalize')).toBe('none');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input).toHaveAccessibleDescription(
      'Lowercase letters, digits and hyphens, 3 to 32. Guests wait until you let them in. ' +
        'The link stays yours while it is used at least once every 30 days; after that nobody can use the name again.'
    );
  });

  it('creates the room under the normalised name and goes to its lobby', async () => {
    await openForm(
      () => new Response(JSON.stringify({ slug: 'my-show', host_token: 'tok-1', expires_at: 1 }), { status: 201 })
    );
    submit('  My   Show ');
    await waitFor(() => expect(window.location.href).toBe('/r/my-show/'));
    expect(roomCalls()).toHaveLength(1);
    expect(roomCalls().map(([, init]) => init.body)).toEqual(['{"name":"my-show"}']);
    expect(localStorage.getItem('om_host_my-show')).toBe('tok-1');
  });

  it('shows Creating… and disables the button while the request runs', async () => {
    await openForm(() => new Promise<Response>(() => {}));
    submit('my-show');
    const button = await screen.findByRole('button', { name: 'Creating…' });
    expect(button).toBeDisabled();
  });

  it.each([
    ['ab', 'Use 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.'],
    ['-my-show', 'Use 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.'],
    ['my_show', 'Use 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.'],
    ['abc-defg-hij', 'That looks like a random room link. Choose another name.'],
  ])('says %s is unusable and sends nothing', async (typed, line) => {
    await openForm();
    submit(typed);
    expect(screen.getByRole('alert')).toHaveTextContent(line);
    expect(roomCalls()).toHaveLength(0);
  });

  it.each([
    [409, 'That name is taken. Choose another.'],
    [400, 'Use 3 to 32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.'],
    [429, 'Too many new rooms from this network. Try again in a minute.'],
    [500, 'Could not create the room. Try again.'],
  ])('says the line for an answer of %i and stays on the page', async (status, line) => {
    await openForm(() => new Response('{}', { status }));
    submit('my-show');
    expect(await screen.findByRole('alert')).toHaveTextContent(line);
    expect(window.location.href).toBe('/');
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled();
  });

  it('says the general line when the network fails', async () => {
    await openForm(() => Promise.reject(new TypeError('Failed to fetch')));
    submit('my-show');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the room. Try again.');
  });

  it('clears the line when the input changes', async () => {
    await openForm();
    submit('ab');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Link name'), { target: { value: 'abc' } });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves New Room posting with no body', async () => {
    await showPage();
    fireEvent.click(screen.getByRole('button', { name: /New Room/i }));
    await waitFor(() => expect(roomCalls()).toHaveLength(1));
    expect(roomCalls().map(([, init]) => init.body)).toEqual([undefined]);
  });
});
