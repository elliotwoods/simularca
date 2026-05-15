import ReactDOM from "react-dom/client";
import "flexlayout-react/style/dark.css";
import "@/styles.css";
import { installDevConsoleFilter } from "@/app/devConsoleFilter";
import { App } from "@/app/App";
import { getKernel } from "@/app/kernel";
import { KernelProvider } from "@/app/KernelContext";
import { startRuntimeStatsHeartbeat } from "@/app/runtimeStats";

if (import.meta.env.DEV) {
  installDevConsoleFilter();
}

const kernel = getKernel();
startRuntimeStatsHeartbeat(kernel);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <KernelProvider kernel={kernel}>
    <App />
  </KernelProvider>
);

