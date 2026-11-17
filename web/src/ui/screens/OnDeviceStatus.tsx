import { useAirlock, useSession } from "../../app/context";
import { Banner } from "../components";

/** Chrome's on-device model state + the user-gesture button that prepares it. */
export function OnDeviceStatus() {
  const s = useSession();
  const { availability, downloadProgress } = useAirlock();
  if (s.services.mode === "demo") return <Banner tone="warn" title="Demo mode — scripted answers">No real AI calls are made. Remove “?demo=1” from the address to use Chrome’s on-device model and Gemini.</Banner>;
  if (s.services.mode === "noCloud") return <Banner tone="warn" title="Firebase isn’t configured">Airlock will seal with rules only and can’t ask Gemini. See the README to add your Firebase config.</Banner>;
  if (downloadProgress !== null) return <Banner tone="info" title={`Preparing the on-device model… ${Math.round(downloadProgress * 100)}%`}>Chrome is downloading its model to this computer. This happens once.</Banner>;
  switch (availability) {
    case "available": return <Banner tone="ok" title="On-device AI is ready">Chrome’s built-in model reads your text on this computer before anything is sent.</Banner>;
    case "checking": return <Banner tone="info" title="Checking for Chrome’s on-device model…" />;
    case "downloadable":
    case "downloading":
      return <Banner tone="warn" title="On-device AI needs a one-time setup" action={<button className="btn btn-primary" onClick={() => void s.enableOnDevice()}>Enable on-device AI</button>}>Chrome will download its model to this computer. Until then Airlock uses strict rules and asks you to check everything.</Banner>;
    default:
      return <Banner tone="warn" title="This browser can’t run on-device AI">Airlock still works: it seals with strict rules and asks you to review everything before anything is sent. For the full experience use desktop Chrome 148+ with built-in AI.</Banner>;
  }
}
