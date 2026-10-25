import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel, numberPeers, personTag, type ChatMessage } from '@/components/ChatPanel';
import { MAX_CHAT_MESSAGE_LENGTH } from '@/lib/sync-report';

describe('ChatPanel', () => {
  it('renders messages and sends composer text', () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        messages={[{ from: 'guest', text: 'hi', ts: 1 }]}
        onSend={onSend}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('hi')).toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveAttribute('maxlength', String(MAX_CHAT_MESSAGE_LENGTH));
    fireEvent.change(screen.getByPlaceholderText(/message/i), { target: { value: 'yo' } });
    fireEvent.submit(screen.getByTestId('chat-form'));
    expect(onSend).toHaveBeenCalledWith('yo');
  });

  it('shows empty state copy visible to everyone', () => {
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Messages are visible to everyone in the call.')).toBeInTheDocument();
    expect(screen.queryByText(/the other participant/i)).not.toBeInTheDocument();
  });

  it('labels a message from peer with their name and own message as You', () => {
    render(
      <ChatPanel
        messages={[
          { from: 'guest', text: 'hello from B', ts: 1, fromName: 'Bob' },
          { from: 'host', text: 'hi Bob', ts: 2, self: true },
          { from: 'guest', text: 'message without name', ts: 3 },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('Guest')).toBeInTheDocument();
  });

  it('shows a focus ring around the message box, since the input drops its own outline', () => {
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Message').parentElement?.className).toMatch(/focus-within:ring/);
  });

  it('wraps long unbroken text inside the bubble and fills its column instead of fixing its own width', () => {
    const long = 'x'.repeat(240);
    const { container } = render(
      <ChatPanel messages={[{ from: 'guest', text: long, ts: 1 }]} onSend={vi.fn()} onClose={vi.fn()} />
    );
    expect(screen.getByText(long).className).toMatch(/\bwrap-anywhere\b/);
    // The desktop column already sizes the panel; a second fixed width overflowed it by its border.
    expect(container.querySelector('aside')?.className).not.toMatch(/sm:w-/);
  });

  it('is a labelled region that closes on Escape', () => {
    const onClose = vi.fn();
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={onClose} />);
    const panel = screen.getByRole('complementary', { name: 'In-call messages' });
    expect(screen.getByRole('heading', { name: 'In-call messages' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText('Message'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(panel).toBeInTheDocument();
  });

  // Click Chat, then type: no second click into the box. Mouse only, so a
  // touch screen doesn't throw its keyboard over the call.
  it('focuses the composer on open with a mouse, not on a touch screen', () => {
    const original = window.matchMedia;
    try {
      window.matchMedia = vi.fn((q: string) => ({ matches: q === '(pointer: fine)' })) as unknown as typeof window.matchMedia;
      const { unmount } = render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
      expect(document.activeElement).toBe(screen.getByLabelText('Message'));
      unmount();

      window.matchMedia = vi.fn(() => ({ matches: false })) as unknown as typeof window.matchMedia;
      render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
      expect(document.activeElement).not.toBe(screen.getByLabelText('Message'));
    } finally {
      window.matchMedia = original;
    }
  });

  it('keeps the composer text at 16px on phones so iOS does not zoom the call on focus', () => {
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText('Message').className).toMatch(/(^|\s)text-base(\s|$)/);
  });

  describe('auto-scroll', () => {
    // jsdom has no layout: give the list a fixed geometry to scroll within.
    function setup() {
      const msgs = [{ from: 'guest' as const, text: 'one', ts: 1 }];
      const props = { onSend: vi.fn(), onClose: vi.fn() };
      const { rerender } = render(<ChatPanel messages={msgs} {...props} />);
      const list = screen.getByTestId('chat-list');
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });
      return { list, add: (m: object[]) => rerender(<ChatPanel messages={[...msgs, ...(m as typeof msgs)]} {...props} />) };
    }

    it('scrolls to the newest message when one arrives', () => {
      const { list, add } = setup();
      add([{ from: 'guest', text: 'two', ts: 2 }]);
      expect(list.scrollTop).toBe(1000);
    });

    it('leaves the list alone while the user reads history, but always shows their own send', () => {
      const { list, add } = setup();
      list.scrollTop = 100;
      fireEvent.scroll(list);
      add([{ from: 'guest', text: 'two', ts: 2 }]);
      expect(list.scrollTop).toBe(100);
      add([
        { from: 'guest', text: 'two', ts: 2 },
        { from: 'host', text: 'mine', ts: 3, self: true },
      ]);
      expect(list.scrollTop).toBe(1000);
    });
  });
});

describe('ChatPanel: a line that was not handed to someone', () => {
  const own = { from: 'host' as const, text: 'hello', ts: 1, self: true };
  const show = (...messages: ChatMessage[]) =>
    render(<ChatPanel messages={messages} onSend={vi.fn()} onClose={vi.fn()} />);

  it('says to whom a line for everyone did not get through, in the page’s own words', () => {
    show({
      ...own,
      notDeliveredTo: [
        { peerId: 'p-bob', role: 'guest' },
        { peerId: 'p-host', role: 'host' },
      ],
    });
    const note = screen.getByRole('status');
    expect(note).toHaveTextContent(/^Not delivered to Guest 1, Host\.$/);
    expect(note.className).toBe('mt-0.5 text-xs text-[#fdd663]');
    expect(screen.getByText('hello').nextElementSibling).toBe(note);
  });

  it('says only "Not delivered." under a private line', () => {
    show({
      ...own,
      private: true,
      toPeerId: 'p-bob',
      toRole: 'guest',
      notDeliveredTo: [{ peerId: 'p-bob', role: 'guest' }],
    });
    expect(screen.getByRole('status')).toHaveTextContent(/^Not delivered\.$/);
  });

  it('draws no note under a line from someone else, whatever it carries', () => {
    show({ from: 'guest', text: 'hey', ts: 1, fromName: 'Bob', notDeliveredTo: [{ peerId: 'p-ann', role: 'guest' }] });
    expect(screen.getByText('hey')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('draws no note under a line with an empty list or none', () => {
    show({ ...own, notDeliveredTo: [] }, { ...own, text: 'again' });
    expect(screen.getByText('again')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('tells in the empty panel that lines go straight to each person', () => {
    render(<ChatPanel messages={[]} onSend={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText('Messages are visible to everyone in the call.')).toBeInTheDocument();
    expect(screen.getByText('They go straight to each person, not through the server.')).toBeInTheDocument();
  });
});

describe('numberPeers', () => {
  it('numbers people in the order they are listed, not the order one writes first', () => {
    const numbers = new Map<string, number>();
    numberPeers(
      [
        { peerId: 'sam', role: 'guest' },
        { peerId: 'screen', role: 'guest', companion: true },
        { peerId: 'lee', role: 'guest' },
      ],
      numbers
    );
    expect(personTag('lee', 'guest', numbers)).toBe('Guest 2');
    expect(personTag('sam', 'guest', numbers)).toBe('Guest 1');
    expect(numbers.has('screen')).toBe(false);
  });
});
