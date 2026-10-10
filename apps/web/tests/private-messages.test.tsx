import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel, chatSenderLabel, recipientLabels } from '@/components/ChatPanel';

describe('ChatPanel: a private line', () => {
  it('says who it is between, on the recipient’s screen and on the sender’s', () => {
    render(
      <ChatPanel
        messages={[
          { from: 'producer', text: 'two minutes', ts: 1, fromName: 'Pat', private: true },
          { from: 'guest', text: 'psst', ts: 2, private: true },
          { from: 'host', text: 'ok', ts: 3, self: true, private: true, toName: 'Pat' },
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
    expect(line('Private · to Pat')).toBe('Private · to PatYou');
    expect(line('Private · to one person')).toBe('Private · to one personYou');
    // A line for everyone reads as it always did.
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('hello Bob').parentElement?.textContent).toBe('Youhello Bob');
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
      'Bob (guest)',
      'Pat (guest)',
      `${'x'.repeat(16)}… (guest)`,
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
    expect(screen.getByText('Only Bob (guest) gets it. It is left out of the recorded chat.')).toBeInTheDocument();
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
      ['p-pat', 'Pat (guest)'],
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
    expect(to()).toHaveAccessibleDescription('Only Bob (guest) gets it. It is left out of the recorded chat.');

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
    expect(Array.from(to().options).map((o) => o.textContent)).toEqual(['Everyone', 'Bob (guest)', `${cut} (guest)`]);
    expect(screen.getByText(`Only ${cut} (guest) gets it. It is left out of the recorded chat.`)).toBeInTheDocument();
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
          { from: 'host', text: 'ok', ts: 3, self: true, private: true, toName: 'Pat' },
        ]}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    const line = (mark: string) => screen.getByText(mark).parentElement?.textContent;
    expect(screen.getByText('Private · from a guest')).toHaveAttribute('data-private-mark');
    expect(line('Private · from a guest')).toBe('Private · from a guestHana');
    expect(line('Private · from the host')).toBe('Private · from the hostHost');
    expect(line('Private · to Pat')).toBe('Private · to PatYou');
  });

  it('the label is the name alone', () => {
    expect(chatSenderLabel({ from: 'guest', fromName: 'Hana', private: true })).toBe('Hana');
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
      'Ana (host)',
      'Ana (guest)',
      'Ana (guest) 2',
      'Everyone (guest)',
    ]);
    expect(screen.getByText('Only Ana (guest) 2 gets it. It is left out of the recorded chat.')).toBeInTheDocument();
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
    const given = new Map<string, string>();
    const bob = { peerId: 'p-bob', name: 'Bob', role: 'guest' };
    const other = { peerId: 'p-other', name: 'Bob', role: 'guest' };
    const labels = (list: { peerId: string; name: string; role: string }[]) =>
      recipientLabels(list, given).map((r) => [r.peerId, r.label]);
    expect(labels([bob, other])).toEqual([
      ['p-bob', 'Bob (guest)'],
      ['p-other', 'Bob (guest) 2'],
    ]);
    expect(labels([bob, other])).toEqual([
      ['p-bob', 'Bob (guest)'],
      ['p-other', 'Bob (guest) 2'],
    ]);
    expect(labels([other, { ...bob, peerId: 'p-bob-again' }])).toEqual([
      ['p-other', 'Bob (guest) 2'],
      ['p-bob-again', 'Bob (guest) 3'],
    ]);
  });

  it('drops direction marks from a name, so the role after it reads as written', () => {
    const marks = '\u061C\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069';
    const label = (name: string) => recipientLabels([{ peerId: 'p-x', name, role: 'guest' }])[0]?.label;
    expect(label('Bob (host)\u202E')).toBe('Bob (host) (guest)');
    expect(label(`A${marks}na`)).toBe('Ana (guest)');
  });

  it('gives a person whose name arrives later a label for that name', () => {
    const given = new Map<string, string>();
    const label = (name: string) => recipientLabels([{ peerId: 'p-x', name, role: 'guest' }], given)[0]?.label;
    expect(label('Guest')).toBe('Guest (guest)');
    expect(label('Ana')).toBe('Ana (guest)');
  });
});
