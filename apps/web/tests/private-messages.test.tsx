import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChatPanel } from '@/components/ChatPanel';

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
    expect(screen.getByText('Pat, privately to you')).toBeInTheDocument();
    expect(screen.getByText('Guest, privately to you')).toBeInTheDocument();
    expect(screen.getByText('You, privately to Pat')).toBeInTheDocument();
    expect(screen.getByText('You, privately to one person')).toBeInTheDocument();
    // A line for everyone reads as it always did.
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });
});

describe('ChatPanel: choosing who a message is for', () => {
  const bob = { peerId: 'p-bob', name: 'Bob' };
  const pat = { peerId: 'p-pat', name: 'Pat' };
  const to = () => screen.getByLabelText('To') as HTMLSelectElement;
  const type = (text: string) =>
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: text } });
  const submit = () => fireEvent.submit(screen.getByTestId('chat-form'));

  it('offers everyone and each person, and tells its caller who was picked', () => {
    const onTo = vi.fn();
    render(
      <ChatPanel
        messages={[]}
        recipients={[bob, pat, { peerId: 'p-long', name: 'x'.repeat(40) }]}
        onTo={onTo}
        onSend={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(Array.from(to().options).map((o) => o.textContent)).toEqual([
      'Everyone',
      'Bob',
      'Pat',
      `${'x'.repeat(16)}…`,
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
    expect(screen.getByText('Only Bob gets it. It is left out of the recorded chat.')).toBeInTheDocument();
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
      ['p-pat', 'Pat'],
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
});
