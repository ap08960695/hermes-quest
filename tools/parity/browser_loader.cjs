'use strict';
// Opt in only on synthetic test pages; production never publishes the facade.
const init = () => { window.__questTestGlobals = true; };
function enable(browser) {
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await newContext(...args);
    await context.addInitScript(init);
    return context;
  };
  return browser;
}
module.exports = {init, enable};
