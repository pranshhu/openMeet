import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { ChatPanel, chatSenderLabel, recipientLabels } from '@/components/ChatPanel';
import { useRoom } from '@/hooks/useRoom';

let signalHandlers: Record<string, ((m: any) => void)[]> = {};

vi.mock('@/lib/api', () => ({
  getTurnCred: vi.fn().mockResolvedValue({ iceServers: [] }),
  getRoom: vi.fn().mockResolvedValue({ slug: 'test-room', expires_at: Date.now() + 10000 }),
}));

vi.mock('@/lib/host-token', () => ({
  getHostToken: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/signal', () => ({
  SignalClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    close: vi.fn(),
    send: vi.fn(),
    on: vi.fn((type: string, handler: (m: any) => void) => {
      (signalHandlers[type] ??= []).push(handler);
    }),
  })),
}));

vi.mock('@/lib/peer', () => ({
  PeerConnection: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    close: vi.fn(),
    setLocalStream: vi.fn(),
    setLocalStreamAfterFirstOffer: vi.fn(),
    createControlChannel: vi.fn(),
    addTransceiver: vi.fn(),
    restartIce: vi.fn(),
    addTrack: vi.fn(),
    connectionState: 'connected',
    rawConnection: null,
    setPeerCount: vi.fn(),
    whenConnected: vi.fn().mockResolvedValue(undefined),
    sendChat: vi.fn().mockReturnValue(true),
    createRecordingChannel: vi.fn().mockReturnValue({
      readyState: 'open',
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }),
    createRecordingAudioChannel: vi.fn().mockReturnValue({
      readyState: 'open',
      addEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    }),
  })),
}));

describe('ChatPanel: a private line', () => {
  it('says who it is between, on the recipient’s screen and on the sender’s', () => {
    render(
      <ChatPanel
        messages={[
          { from: 'producer', text: 'two minutes', ts: 1, fromName: 'Pat', private: true },
          { from: 'guest', text: 'psst', ts: 2, private: true },
          { from: 'host', text: 'ok', ts: 3, self: true, private: true, toPeerId: 'p-pat', toRole: 'producer' },
          { from: 'host', text: 'to someone', ts: 4, self: true, private: true },
          { from: 'guest', text: 'hello all', ts: 5, fromName: 'Bob' },
          { from: 'host', text: 'hello Bob', ts: 6, self: true },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    // The mark is an element of its own; the line is the mark, then the bare name.
    const line = (mark: string) => screen.getByText(mark).parentElement?.textContent;
    expect(screen.getByText('Private · from a producer')).toHaveAttribute('data-private-mark');
    expect(line('Private · from a producer')).toBe('Private · from a producerPat');
    expect(line('Private · from a guest')).toBe('Private · from a guestGuest');
    expect(line('Private · to Producer 1')).toBe('Private · to Producer 1You');
    expect(line('Private · to one person')).toBe('Private · to one personYou');
    // A line for everyone starts with the page's words for it, which are not drawn.
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('hello Bob').parentElement?.textContent).toBe('To everyone: Youhello Bob');
  });
});

describe('ChatPanel: choosing who a message is for', () => {
  const bob = { peerId: 'p-bob', name: 'Bob', role: 'guest' };
  const pat = { peerId: 'p-pat', name: 'Pat', role: 'guest' };
  const to = () => screen.getByLabelText('To') as HTMLSelectElement;
  const type = (text: string) =>
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  const submit = () => fireEvent.submit(screen.getByTestId('chat-form'));

  it('offers everyone and each person, and tells its caller who was picked', () => {
    const onTo = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        recipients={[bob, pat, { peerId: 'p-long', name: 'x'.repeat(40), role: 'guest' }]}
        onTo={onTo}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(Array.from(to().options).map((o) => o.textContent)).toEqual([
      'Everyone',
      'Guest 1: Bob',
      'Guest 2: Pat',
      `Guest 3: ${'x'.repeat(16)}…`,
    ]);
    expect(to().value).toBe('');

    fireEvent.change(to(), { target: { value: 'p-pat' } });
    expect(onTo).toHaveBeenLastCalledWith('p-pat');
  });

  it('sends to the person chosen and names who gets it; to everyone it sends the text alone', () => {
    const onSend = vi.fn();
    const props = { messages: [], recipients: [bob, pat], onTo: vi.fn(), onSend, onClose: vi.fn() };
    const { rerender } = render(<ChatPanel {...props} />);
    expect(screen.queryByText(/gets it/)).toBeNull();
    type('to all');
    submit();
    expect(onSend).toHaveBeenLastCalledWith('to all');

    rerender(<ChatPanel {...props} to="p-bob" />);
    expect(to().value).toBe('p-bob');
    expect(document.getElementById('chat-to-note')?.textContent).toBe(
      'Only Guest 1 (Bob) gets it. It is left out of the recorded chat.'
    );
    type('psst');
    submit();
    expect(onSend).toHaveBeenLastCalledWith('psst', 'p-bob');
  });

  it('offers no choice with nobody or one other person, unless a person is already chosen', () => {
    const props = { messages: [], onSend: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<ChatPanel {...props} />);
    expect(screen.queryByLabelText('To')).toBeNull();
    rerender(<ChatPanel {...props} recipients={[bob]} />);
    expect(screen.queryByLabelText('To')).toBeNull();
    rerender(<ChatPanel {...props} recipients={[bob]} to="p-bob" />);
    expect(to().value).toBe('p-bob');
  });

  it('sends nothing while the person it was for is gone, and never falls back to everyone', () => {
    const onSend = vi.fn();
    const props = { messages: [], onTo: vi.fn(), onSend, onClose: vi.fn() };
    const { rerender } = render(<ChatPanel {...props} recipients={[bob, pat]} to="p-bob" />);
    type('for Bob only');

    // Bob leaves, or comes back under a new id.
    rerender(<ChatPanel {...props} recipients={[pat]} to="p-bob" />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'That person left the call or reconnected. Choose who to send to.'
    );
    expect(Array.from(to().options).map((o) => [o.value, o.textContent])).toEqual([
      ['', 'Everyone'],
      ['p-bob', 'Not available'],
      ['p-pat', 'Guest 2: Pat'],
    ]);
    expect(to().value).toBe('p-bob');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    submit();
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('for Bob only');

    // The sender chooses again: everyone, here.
    rerender(<ChatPanel {...props} recipients={[pat]} to="" />);
    expect(screen.queryByRole('alert')).toBeNull();
    submit();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('for Bob only');
  });

  it('is a labelled control a thumb can use on a phone', () => {
    render(<ChatPanel messages={[]} recipients={[bob, pat]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(to().tagName).toBe('SELECT');
    // 44 px to tap, 16 px text, and never wider than the sheet.
    expect(to().className).toMatch(/(^|\s)min-h-11(\s|$)/);
    expect(to().className).toMatch(/(^|\s)text-base(\s|$)/);
    expect(to().className).toMatch(/(^|\s)min-w-0(\s|$)/);
  });

  it('reads the note out with the control it belongs to', () => {
    const props = { messages: [], onSend: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<ChatPanel {...props} recipients={[bob, pat]} />);
    expect(to()).not.toHaveAttribute('aria-describedby');

    rerender(<ChatPanel {...props} recipients={[bob, pat]} to="p-bob" />);
    expect(to()).toHaveAttribute('aria-describedby', 'chat-to-note');
    expect(document.getElementById('chat-to-note')?.textContent).toBe(
      'Only Guest 1 (Bob) gets it. It is left out of the recorded chat.'
    );

    rerender(<ChatPanel {...props} recipients={[pat]} to="p-bob" />);
    expect(to()).toHaveAccessibleDescription('That person left the call or reconnected. Choose who to send to.');
  });

  it('cuts a long name between characters, never inside one', () => {
    render(
      <ChatPanel
        messages={[]}
        recipients={[bob, { peerId: 'p-faces', name: '😀'.repeat(17), role: 'guest' }]}
        to="p-faces"
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const cut = `${'😀'.repeat(16)}…`;
    expect(Array.from(to().options).map((o) => o.textContent)).toEqual(['Everyone', 'Guest 1: Bob', `Guest 2: ${cut}`]);
    expect(document.getElementById('chat-to-note')?.textContent).toBe(
      `Only Guest 2 (${cut}) gets it. It is left out of the recorded chat.`
    );
  });
});

describe('ChatPanel: a private mark no name can draw, and a recipient that stays', () => {
  const toSelect = () => screen.getByLabelText('To') as HTMLSelectElement;

  it('a name cannot draw the private mark', () => {
    render(
      <ChatPanel
        messages={[{ from: 'guest', text: 'hi all', ts: 1, fromName: 'Hana, privately to you' }]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Hana, privately to you').querySelector('[data-private-mark]')).toBeNull();
  });

  it('a private line carries the mark and who it is from', () => {
    render(
      <ChatPanel
        messages={[
          { from: 'guest', text: 'psst', ts: 1, fromName: 'Hana', private: true },
          { from: 'host', text: 'hi', ts: 2, private: true },
          { from: 'host', text: 'ok', ts: 3, self: true, private: true, toPeerId: 'p-pat', toRole: 'guest' },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const line = (mark: string) => screen.getByText(mark).parentElement?.textContent;
    expect(screen.getByText('Private · from a guest')).toHaveAttribute('data-private-mark');
    expect(line('Private · from a guest')).toBe('Private · from a guestHana');
    expect(line('Private · from Host')).toBe('Private · from HostHost');
    expect(line('Private · to Guest 1')).toBe('Private · to Guest 1You');
  });

  it('the label is the name alone', () => {
    expect(chatSenderLabel({ from: 'guest', fromName: 'Hana' })).toBe('Hana');
  });

  it('tells apart two people who read the same under To', () => {
    render(
      <ChatPanel
        messages={[]}
        recipients={[
          { peerId: 'p-1', name: 'Ana', role: 'host' },
          { peerId: 'p-2', name: 'Ana', role: 'guest' },
          { peerId: 'p-3', name: 'Ana', role: 'guest' },
          { peerId: 'p-4', name: 'Everyone', role: 'guest' },
        ]}
        to="p-3"
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(Array.from(toSelect().options).map((o) => o.textContent)).toEqual([
      'Everyone',
      'Host: Ana',
      'Guest 1: Ana',
      'Guest 2: Ana',
      'Guest 3: Everyone',
    ]);
    expect(document.getElementById('chat-to-note')?.textContent).toBe(
      'Only Guest 2 (Ana) gets it. It is left out of the recorded chat.'
    );
  });

  it('says messages go to everyone only while they do', () => {
    const recipients = [
      { peerId: 'p-bob', name: 'Bob', role: 'guest' },
      { peerId: 'p-pat', name: 'Pat', role: 'guest' },
    ];
    const props = { messages: [], recipients, onSend: vi.fn(), onClose: vi.fn() };
    const { rerender } = render(<ChatPanel {...props} to="" />);
    expect(screen.getByText('Messages are visible to everyone in the call.')).toBeInTheDocument();
    rerender(<ChatPanel {...props} to="p-bob" />);
    expect(screen.queryByText('Messages are visible to everyone in the call.')).toBeNull();
  });

  it('never gives one person’s label to another', () => {
    const given = new Map<string, number>();
    const bob = { peerId: 'p-bob', name: 'Bob', role: 'guest' };
    const other = { peerId: 'p-other', name: 'Bob', role: 'guest' };
    const labels = (list: { peerId: string; name: string; role: string }[]) =>
      recipientLabels(list, given).map((r) => [r.peerId, r.label]);
    expect(labels([bob, other])).toEqual([
      ['p-bob', 'Guest 1: Bob'],
      ['p-other', 'Guest 2: Bob'],
    ]);
    expect(labels([bob, other])).toEqual([
      ['p-bob', 'Guest 1: Bob'],
      ['p-other', 'Guest 2: Bob'],
    ]);
    expect(labels([other, { ...bob, peerId: 'p-bob-again' }])).toEqual([
      ['p-other', 'Guest 2: Bob'],
      ['p-bob-again', 'Guest 3: Bob'],
    ]);
  });

  it('gives a person whose name arrives later a label for that name', () => {
    const given = new Map<string, number>();
    const label = (name: string) => recipientLabels([{ peerId: 'p-x', name, role: 'guest' }], given)[0]?.label;
    expect(label('Guest')).toBe('Guest 1: Guest');
    expect(label('Ana')).toBe('Guest 1: Ana');
  });
});

describe('ChatPanel: a person is named by this page, then by their name', () => {
  const label = (name: string, role = 'guest') =>
    recipientLabels([{ peerId: 'p-x', name, role }], new Map<string, number>())[0]?.label;

  it('names that draw alike are still told apart', () => {
    const names = ['Bob', 'Bob​', 'Bob⁠', 'B‍ob', 'Bob­', 'Bob ', 'Bob️', '͏Bob'];
    const labels = recipientLabels(
      names.map((name, i) => ({ peerId: `p-${i}`, name, role: 'guest' })),
      new Map<string, number>()
    ).map((r) => r.label);
    expect(labels).toHaveLength(8);
    names.forEach((_, i) => expect(labels[i]?.startsWith(`Guest ${i + 1}: `)).toBe(true));
  });

  it('the page’s words come before the name', () => {
    expect(label('Host: Priya')).toBe('Guest 1: Host: Priya');
    expect(label('Ana (host)')).toBe('Guest 1: Ana (host)');
  });

  it('a number stays with its person and is never handed on', () => {
    const numbers = new Map<string, number>();
    const bob = { peerId: 'p-bob', name: 'Bob', role: 'guest' };
    const other = { peerId: 'p-other', name: 'Bob', role: 'guest' };
    const labels = (list: { peerId: string; name: string; role: string }[]) =>
      recipientLabels(list, numbers).map((r) => [r.peerId, r.label]);
    labels([bob, other]);
    expect(labels([other, { peerId: 'p-bob-2', name: 'Bob', role: 'guest' }])).toEqual([
      ['p-other', 'Guest 2: Bob'],
      ['p-bob-2', 'Guest 3: Bob'],
    ]);
  });

  it('the host has no number and uses none up', () => {
    const labels = recipientLabels(
      [
        { peerId: 'p-h', name: 'Ana', role: 'host' },
        { peerId: 'p-g', name: 'Bob', role: 'guest' },
      ],
      new Map<string, number>()
    ).map((r) => r.label);
    expect(labels).toEqual(['Host: Ana', 'Guest 1: Bob']);
  });

  it('the note names the person in the page’s words and sets the name apart', () => {
    render(
      <ChatPanel
        messages={[]}
        recipients={[{ peerId: 'p-bob', name: 'Bob', role: 'guest' }]}
        to="p-bob"
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByLabelText('To')).toHaveAttribute('aria-describedby', 'chat-to-note');
    expect(document.getElementById('chat-to-note')?.textContent).toBe(
      'Only Guest 1 (Bob) gets it. It is left out of the recorded chat.'
    );
    expect(document.querySelector('#chat-to-note bdi')?.textContent).toBe('Bob');
  });

  it('a private line says who it is from in the page’s words, with the name set apart', () => {
    render(
      <ChatPanel
        messages={[
          { from: 'producer', text: 'two minutes', ts: 1, fromName: 'Pat', fromPeerId: 'p-pat', private: true },
          { from: 'host', text: 'hi', ts: 2, private: true },
          { from: 'host', text: 'ok', ts: 3, self: true, private: true, toPeerId: 'p-pat', toRole: 'producer' },
        ]}
        recipients={[
          { peerId: 'p-bob', name: 'Bob', role: 'guest' },
          { peerId: 'p-pat', name: 'Pat', role: 'producer' },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const line = (mark: string) => screen.getByText(mark).parentElement?.textContent;
    expect(line('Private · from Producer 2')).toBe('Private · from Producer 2Pat');
    expect(line('Private · from Host')).toBe('Private · from HostHost');
    expect(line('Private · to Producer 2')).toBe('Private · to Producer 2You');
    expect(screen.getByText('Pat').tagName).toBe('BDI');
    expect(screen.getByText('You').tagName).toBe('BDI');
  });

  it('a name that holds a right-to-left override changes nothing this page wrote', () => {
    render(
      <ChatPanel
        messages={[]}
        recipients={[{ peerId: 'p-x', name: 'Bob (host)\u202e', role: 'guest' }]}
        to="p-x"
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const select = screen.getByLabelText('To') as HTMLSelectElement;
    expect(select.options[1]?.textContent?.startsWith('Guest 1: ')).toBe(true);
    const note = document.getElementById('chat-to-note')!;
    const outside = Array.from(note.childNodes)
      .filter((n) => n.nodeName !== 'BDI')
      .map((n) => n.textContent)
      .join('')
      .replace(/\s+/g, ' ');
    expect(outside).toBe('Only Guest 1 () gets it. It is left out of the recorded chat.');
  });
});

describe('useRoom: a line this tab sent privately', () => {
  it('remembers who it went to, by id and by the role the Room gave', async () => {
    const { result } = renderHook(() => useRoom('xyz-test-room'));
    const stream = {
      getTracks: () => [],
      getAudioTracks: () => [{ kind: 'audio' }],
      getVideoTracks: () => [{ kind: 'video' }],
    } as unknown as MediaStream;
    await act(async () => {
      await result.current.join(stream, 'Host Hana');
    });
    act(() => {
      for (const handler of signalHandlers['role-assigned'] ?? []) {
        handler({
          type: 'role-assigned',
          role: 'host',
          peerId: 'p-host',
          ordinal: 1,
          peers: [{ peerId: 'p-pat', ordinal: 2, role: 'producer', displayName: 'Pat' }],
          recording: false,
        });
      }
    });
    act(() => {
      result.current.sendChat('hi', 'p-pat');
    });
    expect(result.current.state.messages).toEqual([
      {
        from: 'host',
        text: 'hi',
        ts: expect.any(Number),
        self: true,
        fromName: 'Host Hana',
        private: true,
        toPeerId: 'p-pat',
        toRole: 'producer',
      },
    ]);
  });
});

describe('ChatPanel: every line starts with words of the page’s own', () => {
  it('a name that types the private mark does not read as a private line', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          { from: 'host', text: 'send it to me', ts: 1, fromName: 'Ana', fromPeerId: 'p-host', private: true },
          { from: 'guest', text: 'send it to me', ts: 2, fromName: 'Private · from HostAna', fromPeerId: 'p-mal' },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const lines = Array.from(container.querySelectorAll('bdi')).map((b) => b.parentElement?.textContent);
    expect(lines).toEqual(['Private · from HostAna', 'To everyone: Private · from HostAna']);
    expect(container.querySelectorAll('[data-private-mark]')).toHaveLength(1);
    expect(screen.getByText('To everyone:')).toHaveClass('sr-only');
  });
});
