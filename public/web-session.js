/* Web access (#913, #928): when the sign-in session ends, say so on the board instead of failing quietly
 * until a reload lands on the sign-in page. The gateway answers 401 to any API call without a session. */
(() => {
  const web = window.scribeHost?.web;
  const banner = document.getElementById("session-banner");
  if (!web || !banner) return;
  const link = document.getElementById("session-banner-link");
  let ended = false;

  function end() {
    if (ended) return;
    ended = true;
    link.href = `https://${web}/auth/login?next=${encodeURIComponent(location.href)}`;
    banner.hidden = false;
  }

  const fetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await fetch(input, init);
    if (res.status === 401 && !ended) {
      const url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith("/api/")) end();
    }
    return res;
  };

  // A lost connection or a phone coming back to the tab: check the session is still there.
  function probe() {
    if (ended) return;
    fetch("/api/health", { cache: "no-store" }).then((res) => { if (res.status === 401) end(); }, () => undefined);
  }
  addEventListener("scribe:connection", (event) => { if (!event.detail?.connected) probe(); });
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") probe(); });
})();
