import { createRoot } from "react-dom/client";
import { Player } from "@s4/ui";

const source = (name: string) =>
  new URL("media/" + name + ".mp4", location.href).href;
createRoot(document.getElementById("root")!).render(<Player source={source} />);
