'use client';

import { useEffect } from 'react';
import { useRoom } from '@/hooks/useRoom';
import { detectBrowserDevice } from '@/lib/browser-guidance';
import { isFsAccessSupported } from '@/lib/fs-writer';
import { isRecordingSupported } from '@/lib/recorder';
import { isScreenShareSupported } from '@/lib/screen';
import { holdTakeLock } from '@/lib/take-lock';
import { downloadNamesFor } from '@/lib/file-names';
import { Lobby } from './Lobby';
import { CallStage } from './CallStage';
import { WaitingRoom } from './WaitingRoom';
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

export function RoomView({ slug }: { slug: string }) {
  const {
    state, join, leave, setMic, setCam, switchCamera, switchMic, sendChat, setPeerRecorded, toggleScreenShare,
    startRecording, endRecording, addMarker, openMediaBoard, newTake, discardTake, readLoad,
    readTrackHealth, setLowPower, acceptBackups, declineBackups, dismissBackup, stopBackup, sendBackups,
    resumeRecording, saveRecordingFromCall, setIncomingVideoOff,
  } = useRoom(slug);
  const producer = isProducerLink();
  const present = isPresentLink();
  const record = recordCapability(state.role, producer, state.notRecorded);
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
        Up to 4 people on camera, plus 2 producers or present‑only screens. Try again once someone
        leaves.
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
    state.role !== 'host' && (state.backupTransfers ?? []).some((t) => t.status === 'offered')
      ? 'Your backup is offered to the host as soon as they join. Keep this tab open.'
      : undefined;
  if (state.phase === 'waiting') {
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
      />
    );
  }
  if (state.phase === 'connecting') {
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
      />
    );
  }
  if (state.phase === 'peer-left') {
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
          </>
        ) : (
          'Your camera and microphone are off. You can close this tab.'
        )}
      </StatusScreen>
    );
  }

  return (
    <CallStage
      slug={slug}
      role={state.role}
      companion={state.companion}
      phase={state.phase as 'in-call' | 'recording' | 'finalizing' | 'done'}
      localStream={state.localStream}
      remoteStream={state.remoteStream}
      remotePeers={state.remotePeers}
      remoteScreenStream={state.remoteScreenStream}
      localScreenStream={state.localScreenStream}
      localName={state.localName}
      peerName={state.remotePeers.find((p) => p.role !== 'producer')?.name ?? null}
      screenSharing={state.screenSharing}
      canRecord={record.canRecord}
      roomRecording={state.peerRecording}
      notRecorded={state.notRecorded}
      capabilities={state.capabilities}
      finalizingGuests={state.finalizingGuests}
      recordBlocked={record.blocked}
      recordUnavailableReason={record.reason}
      messages={state.messages}
      peerPresence={state.remotePeers.find((p) => p.role !== 'producer')?.presence ?? null}
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
      syncReportUrl={state.syncReportUrl}
      sidecarsSaved={state.sidecarsSaved}
      drained={state.drained}
      readLoad={readLoad}
      readTrackHealth={readTrackHealth}
      lowPower={state.lowPower}
      unprotectedRecording={state.unprotectedRecording}
      onSetLowPower={setLowPower}
      incomingVideoOff={state.incomingVideoOff}
      onSetIncomingVideoOff={setIncomingVideoOff}
      onToggleMic={setMic}
      onToggleCam={setCam}
      onMark={addMarker}
      markerCount={state.markers.length}
      chaptersUrl={state.chaptersUrl}
      summary={state.summary}
      takes={state.takes}
      onNewTake={newTake}
      onDiscardTake={discardTake}
      onOpenMediaBoard={openMediaBoard}
      onRecord={() => void startRecording()}
      onEnd={() => void endRecording()}
      onLeave={leave}
      onSendChat={sendChat}
      onSetPeerRecorded={setPeerRecorded}
      onToggleScreen={(source) => void toggleScreenShare(source)}
      presentingRearCamera={state.presentingRearCamera ?? false}
      onSwitchMic={switchMic}
      onSwitchCamera={switchCamera}
      activeMicId={state.activeMicId}
      activeCamId={state.activeCamId}
      backupTransfers={state.backupTransfers}
      onAcceptBackups={() => void acceptBackups()}
      onDeclineBackups={declineBackups}
      onDismissBackup={dismissBackup}
      onStopBackup={stopBackup}
      {...(state.isFallbackMedia !== undefined ? { isFallbackMedia: state.isFallbackMedia } : {})}
    />
  );
}
