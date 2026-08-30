import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.caiovicentino.opencoderemote",
  appName: "OpenCode Remote",
  webDir: "dist",
  ios: {
    contentInset: "always",
    backgroundColor: "#0b0c0f",
  },
  server: {
    // the native shell loads the bundled dist; the app itself talks to the
    // relay over wss from the pairing storage — no live-reload server needed.
    androidScheme: "https",
  },
};

export default config;
