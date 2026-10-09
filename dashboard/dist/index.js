/* Dependency-free Hermes Dashboard SDK entry; React is supplied by the host. */
(() => {
  "use strict";
  const { React } = window.__HERMES_PLUGIN_SDK__;
  const API = "/api/plugins/hermes-quest";

  function HermesQuestPage() {
    return React.createElement("section", {
      "aria-label": "Hermes Quest",
      style: { width: "100%", minWidth: 0 }
    }, React.createElement("iframe", {
      title: "Hermes Quest live activity and replay",
      src: API + "/static/index.html?live=1",
      style: {
        display: "block", width: "100%", height: "calc(100dvh - 9rem)",
        minHeight: 0, border: 0, borderRadius: "8px", background: "#10121c"
      },
      referrerPolicy: "same-origin"
    }));
  }

  window.__HERMES_PLUGINS__.register("hermes-quest", HermesQuestPage);
})();
