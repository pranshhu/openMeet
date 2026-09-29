import { StatusScreen } from '@/components/StatusScreen';

// The static export turns this into out/404.html, which Pages serves for any unknown path.
export default function NotFound() {
  return (
    <StatusScreen title="Page not found" action="Go to openMeet" href="/">
      There’s nothing at this address. Check the link you were sent.
    </StatusScreen>
  );
}
