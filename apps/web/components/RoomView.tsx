'use client';

import { useEffect, useRef, useState } from 'react';
import { useRoom } from '@/hooks/useRoom';
import { detectBrowserDevice } from '@/lib/browser-guidance';
import { isFsAccessSupported } from '@/lib/fs-writer';
import { isRecordingSupported } from '@/lib/recorder';
import { isScreenShareSupported } from '@/lib/screen';
import { holdTakeLock } from '@/lib/take-lock';
import { downloadNamesFor } from '@/lib/file-names';
import { isStagePeer } from '@/lib/stage-peers';
import { parseViewLink, viewName } from '@/lib/view-link';
import type { MediaBoard } from '@/lib/media-board';
import { Lobby } from './Lobby';
import { CleanView } from './CleanView';
import { CallStage } from './CallStage';
import { WaitingRoom } from './WaitingRoom';
import { KnockNotice } from './KnockNotice';
import { RoomAccess } from './RoomAccess';
import { PasscodeForm } from './PasscodeForm';
import { StatusScreen } from './StatusScreen';

/**
 * Whether this peer may START a recording, and why not if it may not.
 *
 * Only the host can: it owns the disk, so it owns the start and the stop. A
 * guest with its own button could stream into a host with no file open, and
 * those bytes go nowhere. Guests join the recording automatically when the host
 * starts one.
 *
 * The codec check still runs for BOTH roles: a guest that can't encode MP4
 * contributes nothing to the recording, and needs to be told that BEFORE the
 * host presses Record, not discover it afterwards.
 */
export function recordCapability(
  role: string | null,
  producer = false,
  notRecorded = false
): { canRecord: boolean; reason: string | null; blocked: boolean } {
  if (role === 'producer' || producer) {
    return {
      canRecord: false,
      blocked: false,
      reason: 'You’re a producer — you are watching and are not recorded.',
    };
  }
  // The line under the status bar says it; "you’ll be captured automatically" would be false.
  if (notRecorded && role !== 'host') return { canRecord: false, blocked: false, reason: null };
  if (!isRecordingSupported()) {
    return {
      canRecord: false,
      blocked: true,
      reason: 'This browser can’t record MP4. Use a Chromium browser such as Google Chrome.',
    };
  }
  if (role !== 'host') {
    // Say so. A guest that just sees no Record button assumes the app is
    // broken — which is exactly what happened the first time this shipped.
    return {
      canRecord: false,
      blocked: false,
      reason: 'The host starts the recording — you’ll be captured automatically.',
    };
  }
  if (!isFsAccessSupported()) {
    return {
      canRecord: false,
      blocked: true,
      // No phone browser can write to a folder, so naming a browser there
      // would send someone already in Chrome to Chrome.
      reason: detectBrowserDevice().isMobile
        ? 'Phones can’t save recordings. To record, host this room from Chrome, Edge or Arc on a computer.'
        : 'Saving recordings needs the File System Access API — use Chrome, Edge, or Arc (Brave works as host only after enabling brave://flags/#file-system-access-api).',
    };
  }
  return { canRecord: true, blocked: false, reason: null };
}

/**
 * A producer joins via `?producer=1` on the room link: present to run the
 * session, never recorded, publishing no media of their own.
 */
function isProducerLink(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('producer') === '1';
}

function isPresentLink(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('present') === '1';
}

/** `?audio=1` on the room link: the lobby opens on Microphone only. */
function isAudioLink(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('audio') === '1';
}

/** `?check=1` on the room link: the lobby's preview and checks, with no way into the room. */
function isCheckLink(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('check') === '1';
}

/** The screens that end a visit keep their own words on a view page too. */
const ENDED_PHASES: readonly string[] = ['not-found', 'full', 'replaced', 'removed', 'refused', 'error', 'left'];

/** Download links for files this tab holds only as links in memory. */
function FileLinks({ files }: { files: readonly (readonly [string | null, string, string])[] }) {
  return (
    <div className="mt-2 flex flex-wrap justify-center gap-x-5">
      {files.map(([url, name, label]) => (
        <a
          key={name}
          href={url ?? undefined}
          download={name}
          className="inline-flex min-h-11 items-center rounded-sm text-[15px] font-medium text-[#0b57d0] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0b57d0]"
        >
          {label}
        </a>
      ))}
    </div>
  );
}

/** What a refused person reads, by the reason the Room gave. */
const REFUSALS = {
  locked: ['This room is locked', 'The host locked it, so nobody new can join. Ask the host to unlock it, then try again.'],
  refused: ['The host didn’t let you in', 'Ask the host, then try again.'],
  busy: ['Too many people are waiting', 'The room’s waiting list is full. Try again in a minute.'],
  passcode: ['Too many wrong passcodes', 'Wait ten minutes, then try again, or ask the host.'],
  other: ['You can’t join this room right now', 'Ask the host, then try again.'],
} as const;

export function RoomView({ slug }: { slug: string }) {
  const {
    state, join, leave, setMic, setCam, switchCamera, switchMic, sendChat, setPeerRecorded, toggleScreenShare,
    mutePeer, askPeer, dismissHelpAsk, restartConnection, removePeer, setRoomAccess, sendPasscode, admitPeer,
    recordWithCountdown, endRecording, addMarker, openMediaBoard, newTake, discardTake, readLoad,
    sendScript, dismissIncomingScript,
    readTrackHealth, setLowPower, acceptBackups, declineBackups, dismissBackup, stopBackup, sendBackups,
    resumeRecording, saveRecordingFromCall, setIncomingVideoOff, setHandRaised, sendReaction,
    declineFiles, sendFile,
    setSendLater,
  } = useRoom(slug);
  // The numbers this page gave people under To. Held here because the call
  // screen is unmounted while everyone else is away and the chat lines are
  // not: a line kept from before must still show the number it showed.
  const [chatNumbers] = useState(() => new Map<string, number>());
  // Who the next chat message is for, held here for the same reason: a
  // person chosen before everyone left is still the choice when the call
  // screen is back, or a message written for them would go to everyone.
  const [chatTo, setChatTo] = useState('');
  // The media board this page made, held here for the same reason: a board
  // made before everyone left is still in the mix when the call screen is
  // back, so showing it again is not making it during a take.
  const [board, setBoard] = useState<MediaBoard | null>(null);
  const producer = isProducerLink();
  const present = isPresentLink();
  const check = isCheckLink();
  const audio = isAudioLink();
  const record = recordCapability(state.role, producer, state.notRecorded);
  // `?view=` makes this page a view of one person: it joins by itself, asks for
  // no camera or microphone, and ignores the flags above.
  const [view] = useState(() => (typeof window === 'undefined' ? null : parseViewLink(window.location.search)));
  // Once per page load: a view that left the room is not sent back in, and
  // StrictMode runs this effect twice in development.
  const viewJoined = useRef(false);
  useEffect(() => {
    if (!view || view.kind === 'incomplete' || state.phase !== 'lobby' || viewJoined.current) return;
    viewJoined.current = true;
    void join(new MediaStream(), viewName(view), true);
  }, [view, state.phase, join]);
  // A host who went on without anyone else. Kept while this tab stays in the
  // room: the call screen then stays up while they are alone, while someone
  // connects and after everyone has left.
  const [alone, setAlone] = useState(false);
  // After a host leaves mid-take, sync.json, the chapters and the backups are
  // in-memory links in this tab, and a finalized take's backups are deleted by
  // the next lobby. Rejoin reloads, so ask before any way out of the page.
  const unsavedSidecars = !state.sidecarsSaved && (state.syncReportUrl || state.chaptersUrl);
  const unsaved =
    state.phase === 'left' &&
    state.role === 'host' &&
    !!(unsavedSidecars || state.backupBlobUrl || state.wavBackupBlobUrl);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  // A second tab in this browser would take the host seat from under a live
  // take. This tab holds the room's take lock for as long as its take is, so
  // that tab's lobby can ask first. Resuming or saving an interrupted take
  // counts from the click: until it ends, that take's crash copy is this tab's
  // to work on, and another tab's lobby must not list it.
  const hostTakeLive =
    state.role === 'host' &&
    (state.phase === 'recording' || state.phase === 'finalizing' || state.recoveryBusy);
  useEffect(() => (hostTakeLive ? holdTakeLock(slug) : undefined), [hostTakeLive, slug]);

  if (view && !ENDED_PHASES.includes(state.phase)) {
    return <CleanView link={view} peers={state.remotePeers} door={state.door} onPasscode={sendPasscode} />;
  }
  if (state.phase === 'checking') {
    return <StatusScreen spinner>Checking room…</StatusScreen>;
  }
  if (state.phase === 'not-found') {
    return (
      <StatusScreen title="Room not found or expired" action="Go to openMeet" href="/">
        Rooms expire after 30 days without a call. Ask the host for a fresh link, or start your own from
        the home page.
      </StatusScreen>
    );
  }
  if (state.phase === 'full') {
    return (
      <StatusScreen title="This room is full" action="Try again">
        A room seats 4 people, or 8 when everyone joins with the microphone only, plus 2 producers, view links or
        present‑only screens. Try again once someone leaves.
      </StatusScreen>
    );
  }
  if (state.phase === 'replaced') {
    return (
      <StatusScreen title="You joined from another tab or device" action="Use this tab instead">
        The call continues in the other tab or device. Using this tab instead disconnects that one — if
        it’s recording, press End &amp; save there first.
      </StatusScreen>
    );
  }
  if (state.phase === 'removed') {
    // The backup of a recording this tab saved is a link held in memory, and
    // Back to the lobby reloads the page. Offered here first; the lobby lists
    // the copy in browser storage afterwards.
    const names = downloadNamesFor({ room: slug, localName: state.localName, role: state.role });
    const files = (
      [
        [state.backupBlobUrl, names.backup, 'Download your backup'],
        [state.wavBackupBlobUrl, names.wav, 'Download your WAV backup'],
      ] as const
    ).filter(([url]) => url);
    return (
      <StatusScreen
        title="The host removed you from this call"
        action="Back to the lobby"
        secondary={{ label: 'Back to home', href: '/' }}
      >
        This tab can’t rejoin until the call has ended.{' '}
        {files.length > 0
          ? 'Your backup copies stay in this browser — download them now, or later from the lobby.'
          : 'If you were being recorded, your backup copy stays in this browser — the lobby lists it.'}
        {files.length > 0 && <FileLinks files={files} />}
      </StatusScreen>
    );
  }
  if (state.phase === 'refused') {
    const [title, text] = (state.refusal && REFUSALS[state.refusal]) || REFUSALS.other;
    return (
      <StatusScreen title={title} action="Try again" secondary={{ label: 'Back to home', href: '/' }}>
        {text}
      </StatusScreen>
    );
  }
  if (state.phase === 'error') {
    return (
      <StatusScreen title="Can’t reach openMeet" action="Try again">
        {state.error}
      </StatusScreen>
    );
  }
  if (state.phase === 'lobby') {
    return (
      <Lobby
        slug={slug}
        producer={producer}
        present={present}
        checkOnly={check}
        audio={audio}
        onSendBackups={sendBackups}
        onJoin={(stream, name, asCompanion, screenStream, stereo) =>
          void join(stream, name, producer, asCompanion, screenStream, stereo)
        }
      />
    );
  }
  // A present-only device has no camera: confirm the screen it picked is what
  // people will see, while it is still sharing one.
  const companionNote = state.companion && state.screenSharing
    ? 'You’re presenting from this device. Your screen appears for everyone once they’re connected.'
    : undefined;
  // A guest waiting alone has nothing else to do but keep the tab open; say so
  // while the backup is still only offered.
  const offeredNote =
    state.role !== 'host' &&
    (state.backupTransfers ?? []).some((t) => t.kind !== 'file' && t.status === 'offered')
      ? 'Your backup is offered to the host as soon as they join. Keep this tab open.'
      : undefined;
  // A host in a browser that can record, and not on a present-only device, may
  // go on to the call screen without waiting for anyone: Record is there.
  const goAlone =
    record.canRecord && !state.companion ? { onContinueAlone: () => setAlone(true) } : {};
  // A host who is alone still answers the people at the door and sets the room
  // controls: they are drawn under the waiting screen's buttons.
  const hostAccess =
    state.role === 'host' && state.access
      ? {
          extra: (
            <>
              <KnockNotice role={state.role} waiting={state.access.waiting} onAdmit={admitPeer} />
              <RoomAccess access={state.access} onChange={setRoomAccess} />
            </>
          ),
        }
      : {};
  // The room asks for a passcode before it seats anyone: one field, and no
  // spinner, as nothing is connecting yet.
  if (
    (state.door === 'passcode' || state.door === 'wrong-passcode') &&
    (state.phase === 'connecting' || state.phase === 'waiting' || state.phase === 'peer-left')
  ) {
    return (
      <WaitingRoom
        role={state.role}
        localStream={state.localStream}
        localName={state.localName}
        onLeave={leave}
        onToggleMic={setMic}
        onToggleCam={setCam}
        title="This room needs a passcode"
        note="Ask the host for it."
        extra={<PasscodeForm wrong={state.door === 'wrong-passcode'} onSubmit={sendPasscode} />}
      />
    );
  }
  // The Room has the join and the host has not answered it: nothing is
  // connecting, so no spinner.
  if (
    state.door === 'waiting' &&
    (state.phase === 'connecting' || state.phase === 'waiting' || state.phase === 'peer-left')
  ) {
    return (
      <WaitingRoom
        role={state.role}
        localStream={state.localStream}
        localName={state.localName}
        onLeave={leave}
        onToggleMic={setMic}
        onToggleCam={setCam}
        title="Waiting for the host to let you in"
        note="The host lets people in one at a time. Keep this tab open."
      />
    );
  }
  if (state.phase === 'waiting' && !alone) {
    const note = companionNote ?? offeredNote;
    return (
      <WaitingRoom
        role={state.role}
        localStream={state.localStream}
        localName={state.localName}
        onLeave={leave}
        onToggleMic={setMic}
        onToggleCam={setCam}
        {...(note ? { note } : {})}
        {...goAlone}
        {...hostAccess}
      />
    );
  }
  if (state.phase === 'connecting' && !alone) {
    // The same dark room as waiting, so a guest arriving doesn't flash a white
    // page; trouble connecting is said here, with Leave still in reach.
    return (
      <WaitingRoom
        role={state.role}
        localStream={state.localStream}
        localName={state.localName}
        onLeave={leave}
        onToggleMic={setMic}
        onToggleCam={setCam}
        busy
        title={state.connectionWarning ? 'Having trouble connecting' : 'Connecting…'}
        note={state.connectionWarning ?? companionNote ?? 'Joining the call. This usually takes a few seconds.'}
        {...hostAccess}
      />
    );
  }
  if (state.phase === 'peer-left' && !alone) {
    // Still in the room: the camera stays on (and on screen), and the call
    // picks up again by itself when someone joins. Only an empty mesh lands
    // here, so it is everyone, in a group call too.
    return (
      <WaitingRoom
        role={state.role}
        localStream={state.localStream}
        localName={state.localName}
        onLeave={leave}
        onToggleMic={setMic}
        onToggleCam={setCam}
        title="Everyone else left"
        note="You’re still in the room. The call picks up again when someone joins."
        {...goAlone}
        {...hostAccess}
      />
    );
  }
  if (state.phase === 'left') {
    // Leaving mid-take (or from the summary) finalizes the take, but these
    // files exist only as in-memory links in this tab. Offer them before Rejoin,
    // whose reload would lose them.
    const names = downloadNamesFor({
      room: slug,
      take: state.takes[state.takes.length - 1]?.take,
      localName: state.localName,
      role: state.role,
    });
    const files = (
      [
        [state.syncReportUrl, names.sync, 'sync.json'],
        [state.chaptersUrl, names.chapters, 'chapters.txt'],
        [state.backupBlobUrl, names.backup, 'Backup video'],
        [state.wavBackupBlobUrl, names.wav, 'Backup audio (WAV)'],
      ] as const
    ).filter(([url]) => url);
    return (
      <StatusScreen title="You left the call" action="Rejoin" secondary={{ label: 'Back to home', href: '/' }}>
        {files.length > 0 ? (
          <>
            {state.role === 'host'
              ? 'Download these before you close this tab — they exist only here.'
              : // A guest's backups are never deleted and are listed in every lobby.
                'Your backup copies stay in this browser — download them now, or later from the lobby next time you open openMeet.'}
            <FileLinks files={files} />
          </>
        ) : (
          'Your camera and microphone are off. You can close this tab.'
        )}
      </StatusScreen>
    );
  }

  // Only a host who went on alone gets here without a call. The call screen
  // then shows as it does before a take.
  const callPhase =
    state.phase === 'waiting' || state.phase === 'connecting' || state.phase === 'peer-left'
      ? 'in-call'
      : (state.phase as 'in-call' | 'recording' | 'finalizing' | 'done');
  return (
    <CallStage
      slug={slug}
      role={state.role}
      companion={state.companion}
      phase={callPhase}
      localStream={state.localStream}
      remoteStream={state.remoteStream}
      remotePeers={state.remotePeers}
      remoteScreens={state.remoteScreens}
      remoteScreenStream={state.remoteScreenStream}
      localScreenStream={state.localScreenStream}
      localName={state.localName}
      peerName={state.remotePeers.find(isStagePeer)?.name ?? null}
      screenSharing={state.screenSharing}
      canRecord={record.canRecord}
      roomRecording={state.peerRecording}
      notRecorded={state.notRecorded}
      capabilities={state.capabilities}
      finalizingGuests={state.finalizingGuests}
      recordBlocked={record.blocked}
      recordUnavailableReason={record.reason}
      messages={state.messages}
      chatNumbers={chatNumbers}
      chatTo={chatTo}
      onChatTo={setChatTo}
      board={board}
      onBoard={setBoard}
      peerPresence={state.remotePeers.find(isStagePeer)?.presence ?? null}
      screenShareSupported={isScreenShareSupported()}
      backupUrl={state.backupBlobUrl}
      wavBackupUrl={state.wavBackupBlobUrl}
      recordingError={state.recordingError ?? state.connectionWarning}
      micWarning={state.micWarning}
      resumeOffer={state.resumeOffer}
      takeNotice={state.takeNotice}
      onResumeRecording={() => void resumeRecording()}
      onSaveRecording={() => void saveRecordingFromCall()}
      recoveryBusy={state.recoveryBusy}
      countdownEndsAt={state.countdownEndsAt}
      syncReportUrl={state.syncReportUrl}
      sidecarsSaved={state.sidecarsSaved}
      drained={state.drained}
      backupQueued={state.backupQueued}
      backupInMemory={state.backupInMemory}
      readLoad={readLoad}
      readTrackHealth={readTrackHealth}
      lowPower={state.lowPower}
      unprotectedRecording={state.unprotectedRecording}
      onSetLowPower={setLowPower}
      incomingVideoOff={state.incomingVideoOff}
      onSetIncomingVideoOff={setIncomingVideoOff}
      sendLater={state.sendLater}
      onSetSendLater={setSendLater}
      handRaised={state.handRaised}
      onSetHandRaised={setHandRaised}
      reactions={state.reactions}
      onReact={sendReaction}
      onToggleMic={setMic}
      onToggleCam={setCam}
      onMark={addMarker}
      markerCount={state.markers.length}
      chaptersUrl={state.chaptersUrl}
      summary={state.summary}
      takes={state.takes}
      onNewTake={() => {
        // With nobody else here the next take is the host's alone, and it
        // belongs on this screen, count included.
        if (!state.remoteStream) setAlone(true);
        newTake();
      }}
      onDiscardTake={discardTake}
      onOpenMediaBoard={openMediaBoard}
      onRecord={() => void recordWithCountdown()}
      onEnd={() => void endRecording()}
      onLeave={leave}
      onSendChat={sendChat}
      incomingScript={state.incomingScript}
      look={state.look}
      onSendScript={sendScript}
      onDismissScript={dismissIncomingScript}
      onSetPeerRecorded={setPeerRecorded}
      hostMuted={state.hostMuted}
      helpAsk={state.helpAsk}
      onRestartConnection={restartConnection}
      onDismissHelpAsk={dismissHelpAsk}
      onMutePeer={mutePeer}
      onAskPeer={askPeer}
      onRemovePeer={removePeer}
      roomAccess={state.access}
      onRoomAccess={setRoomAccess}
      onAdmit={admitPeer}
      onToggleScreen={(source) => void toggleScreenShare(source)}
      presentingRearCamera={state.presentingRearCamera ?? false}
      slides={state.slides}
      onSwitchMic={switchMic}
      onSwitchCamera={switchCamera}
      activeMicId={state.activeMicId}
      activeCamId={state.activeCamId}
      backupTransfers={state.backupTransfers}
      onAcceptBackups={() => void acceptBackups()}
      onDeclineBackups={declineBackups}
      onDismissBackup={dismissBackup}
      onStopBackup={stopBackup}
      onAcceptFiles={(shown) => void acceptBackups(shown)}
      onDeclineFiles={declineFiles}
      onSendFile={state.role !== 'host' ? sendFile : undefined}
      {...(state.isFallbackMedia !== undefined ? { isFallbackMedia: state.isFallbackMedia } : {})}
    />
  );
}
