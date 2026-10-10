import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MAX_SCRIPT_LENGTH } from '@openmeet/protocol';
import { Teleprompter, readingMinutes } from '@/components/Teleprompter';

beforeEach(() => localStorage.clear());

const editor = () => screen.getByPlaceholderText(/paste your script/i);
const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
const offer = () => screen.getByRole('group', { name: 'Script from the host' });
const send = () => screen.getByRole('button', { name: 'Send to everyone' });

describe('readingMinutes', () => {
  it('counts whole minutes at 150 words a minute, and none for no words', () => {
    expect(readingMinutes('')).toBe(0);
    expect(readingMinutes('  \n ')).toBe(0);
    expect(readingMinutes('hello')).toBe(1);
    expect(readingMinutes(words(150))).toBe(1);
    expect(readingMinutes(words(151))).toBe(2);
    expect(readingMinutes(`${words(300)}\n\n${words(150)}`)).toBe(3);
  });
});

describe('Teleprompter: reading time', () => {
  it('says under the editor how long the script takes to read, and nothing for an empty one', () => {
    render(<Teleprompter slug="minutes" onClose={() => {}} />);
    expect(screen.queryByText(/min to read/)).toBeNull();
    fireEvent.change(editor(), { target: { value: words(301) } });
    expect(screen.getByText('About 3 min to read')).toBeInTheDocument();
  });
});

describe('Teleprompter: sending the script', () => {
  it('has no Send for someone who is not given one', () => {
    render(<Teleprompter slug="guest" onClose={() => {}} />);
    fireEvent.change(editor(), { target: { value: 'My notes' } });
    expect(screen.queryByRole('button', { name: 'Send to everyone' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('sends the text as it stands and says it went, until the text is edited', () => {
    const onSend = vi.fn(() => true);
    render(<Teleprompter slug="send-ok" onClose={() => {}} onSend={onSend} />);
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    fireEvent.change(editor(), { target: { value: 'Welcome to the show' } });
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith('Welcome to the show');
    expect(screen.getByRole('status')).toHaveTextContent('Sent. The others can use it or ignore it.');

    fireEvent.change(editor(), { target: { value: 'Welcome to the show!' } });
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('says so when the script did not go out', () => {
    render(<Teleprompter slug="send-fail" onClose={() => {}} onSend={() => false} />);
    fireEvent.change(editor(), { target: { value: 'Welcome to the show' } });
    fireEvent.click(send());
    expect(screen.getByRole('status')).toHaveTextContent('Not sent: no connection. Try again in a moment.');
  });

  it('will not send a script longer than the bound, and says why', () => {
    const onSend = vi.fn(() => true);
    render(<Teleprompter slug="send-long" onClose={() => {}} onSend={onSend} />);

    fireEvent.change(editor(), { target: { value: 'a'.repeat(MAX_SCRIPT_LENGTH) } });
    expect(send()).toBeEnabled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();

    fireEvent.change(editor(), { target: { value: 'a'.repeat(MAX_SCRIPT_LENGTH + 1) } });
    expect(send()).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Too long to send: 50,000 characters at most.');
    fireEvent.click(send());
    expect(onSend).not.toHaveBeenCalled();
  });

  it('will not send a script that is only spaces and line breaks', () => {
    const onSend = vi.fn(() => true);
    render(<Teleprompter slug="send-blank" onClose={() => {}} onSend={onSend} />);
    fireEvent.change(editor(), { target: { value: ' \n\t ' } });
    expect(send()).toBeDisabled();
    fireEvent.click(send());
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });
});

describe('Teleprompter: a script from the host', () => {
  it('shows no offer when none is waiting', () => {
    render(<Teleprompter slug="none" onClose={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Script from the host' })).toBeNull();
  });

  it('leaves the person’s own script alone until they press Use it, then shows and keeps the host’s', () => {
    localStorage.setItem('om_prompter_take', 'My own notes');
    const onIncomingDone = vi.fn();
    render(
      <Teleprompter slug="take" onClose={() => {}} incoming="Welcome to the show" onIncomingDone={onIncomingDone} />
    );

    expect(screen.getByText('My own notes')).toBeInTheDocument();
    expect(offer()).toHaveTextContent('The host sent a script, about 1 min to read. Using it replaces yours.');
    expect(localStorage.getItem('om_prompter_take')).toBe('My own notes');
    expect(onIncomingDone).not.toHaveBeenCalled();

    fireEvent.click(within(offer()).getByRole('button', { name: 'Use it' }));
    expect(screen.getByText('Welcome to the show')).toBeInTheDocument();
    expect(screen.queryByText('My own notes')).toBeNull();
    expect(localStorage.getItem('om_prompter_take')).toBe('Welcome to the show');
    expect(onIncomingDone).toHaveBeenCalledTimes(1);
  });

  it('does not touch what is being typed when a script arrives, and leaves the editor on Use it', () => {
    const { rerender } = render(<Teleprompter slug="typing" onClose={() => {}} />);
    fireEvent.change(editor(), { target: { value: 'Half a sentence' } });
    rerender(<Teleprompter slug="typing" onClose={() => {}} incoming="Welcome to the show" />);
    expect(editor()).toHaveValue('Half a sentence');

    fireEvent.click(within(offer()).getByRole('button', { name: 'Use it' }));
    expect(screen.queryByPlaceholderText(/paste your script/i)).toBeNull();
    expect(screen.getByText('Welcome to the show')).toBeInTheDocument();
  });

  it('says nothing about replacing when the person has no script of their own', () => {
    render(<Teleprompter slug="empty" onClose={() => {}} incoming="Welcome to the show" />);
    expect(offer()).toHaveTextContent('The host sent a script, about 1 min to read.');
    expect(offer()).not.toHaveTextContent('replaces yours');
  });

  it('keeps the person’s own script on Ignore, and reports the answer', () => {
    localStorage.setItem('om_prompter_ignore', 'My own notes');
    const onIncomingDone = vi.fn();
    render(
      <Teleprompter slug="ignore" onClose={() => {}} incoming="Welcome to the show" onIncomingDone={onIncomingDone} />
    );
    fireEvent.click(within(offer()).getByRole('button', { name: 'Ignore' }));
    expect(onIncomingDone).toHaveBeenCalledTimes(1);
    expect(screen.getByText('My own notes')).toBeInTheDocument();
    expect(localStorage.getItem('om_prompter_ignore')).toBe('My own notes');
  });

  it('names the reading time of what was sent, not of the person’s own script', () => {
    render(<Teleprompter slug="long" onClose={() => {}} incoming={words(451)} />);
    expect(offer()).toHaveTextContent('about 4 min to read');
  });

  it('stops a script that is running, and goes back to its top, when the host’s is used', () => {
    localStorage.setItem('om_prompter_scroll', 'line\n'.repeat(200));
    const { rerender } = render(<Teleprompter slug="scroll" onClose={() => {}} />);
    fireEvent.click(screen.getByText('Play'));
    expect(screen.getByText('Pause')).toBeInTheDocument();
    const box = document.querySelector('.overflow-y-auto') as HTMLElement;
    box.scrollTop = 400;

    rerender(<Teleprompter slug="scroll" onClose={() => {}} incoming="Welcome to the show" />);
    fireEvent.click(within(offer()).getByRole('button', { name: 'Use it' }));
    expect(screen.getByText('Play')).toBeInTheDocument();
    expect(box.scrollTop).toBe(0);
  });

  it('makes Send, Use it and Ignore tall enough for a thumb on a phone', () => {
    render(<Teleprompter slug="thumb" onClose={() => {}} incoming="Welcome to the show" onSend={() => true} />);
    for (const name of ['Send to everyone', 'Use it', 'Ignore']) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-11');
    }
  });
});
