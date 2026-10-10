import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
